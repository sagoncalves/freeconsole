/**
 * Ties a device to a room and keeps a game frame in sync with it.
 *
 * Both shells — the screen and the controller — do the same job: claim a slot, follow the
 * room's `home` URL, and swap the game frame when it changes. This module is that shared
 * behaviour, so navigation semantics can't drift between the two.
 */
import { attachGameFrame } from "./relay.js?v=202608012300";
import { connectPeer, measureClock } from "./peer.js?v=2";
import {
  SCREEN,
  STORE_LOCATION,
  claimSlot,
  attachDevice,
  setLocation,
  setCustomState,
  navigate,
  watchRoom,
  watchMessages,
  sendMessage,
  setActivePlayers,
  activePlayerIds,
  controllerIds,
  masterControllerId,
  gameUrl,
} from "./room.js?v=202608012200";

/**
 * @param {object} opts
 * @param {string} opts.roomCode
 * @param {string} opts.uid
 * @param {boolean} opts.isScreen
 * @param {string} [opts.nickname]
 * @param {HTMLElement} opts.stage       where game frames are mounted
 * @param {(url:string) => string} opts.resolveUrl  home URL -> the file this device loads
 * @param {(state:object) => void} opts.onState     called on every room change
 * @returns {Promise<object>} the live session
 */
export async function startSession(opts) {
  const { roomCode, uid, isScreen, nickname = null, stage, resolveUrl, onState } = opts;

  const deviceId = await claimSlot(roomCode, uid, { screen: isScreen });

  let room = { home: STORE_LOCATION, devices: [] };
  let bridge = null;         // active game frame bridge
  let loadedUrl = null;      // which home URL the frame currently holds
  let unwatchRoom = null;
  let unwatchMessages = null;

  // Everything a game can ask the shell to do. Passed to the bridge so the frame never
  // touches Firebase itself.
  /* ---------------------------------------------------------------- fast path */

  // Direct peer connections, keyed by the slot at the other end. Gameplay messages go over
  // these when they are up, and fall back to the database when they are not - the game
  // cannot tell which was used.
  const peers = new Map();
  let clock = { offset: 0, rtt: 0 };

  /**
   * Publishes which transport each peer is using.
   *
   * Without this there is no way to tell a working direct connection from a silent
   * fallback - both just deliver messages. Exposed on window so it can be checked from the
   * console on a real device, where the peer connection actually gets exercised.
   */
  function reportTransport() {
    const state = {};
    for (const [slot, peer] of peers) state[slot] = peer.isOpen() ? "direct" : "relay";
    const summary = {
      deviceId,
      peers: state,
      clockOffsetMs: clock.offset,
      anyDirect: Object.values(state).includes("direct"),
    };
    try { window.__transport = summary; } catch {}
    return summary;
  }

  // Messages carry a per-sender sequence tag so the two transports cannot deliver the same
  // one twice - possible if a peer connection opens or drops while a message is in flight.
  // Bounded, because a long session would otherwise grow this without limit.
  const delivered = new Set();
  function deliverOnce(seq) {
    if (!seq) return false;                 // untagged: database-only, already unique
    if (delivered.has(seq)) return true;    // duplicate, drop it
    delivered.add(seq);
    if (delivered.size > 400) {
      // Drop the oldest half; sequence tags only need to be remembered briefly.
      const keep = [...delivered].slice(-200);
      delivered.clear();
      keep.forEach((k) => delivered.add(k));
    }
    return false;
  }

  // Measure our offset from the shared clock once, in the background. Never block on it.
  measureClock().then((c) => {
    clock = c;
    console.info(`[transport] shared clock offset ${c.offset}ms (measured in ${Math.round(c.rtt)}ms)`);
    reportTransport();
    if (bridge && bridge.pushClock) bridge.pushClock(c);
  });

  /**
   * The slots this device should hold a direct connection to.
   *
   * The screen talks to every controller; a controller only ever talks to the screen. That
   * keeps the number of connections linear rather than quadratic, and matches how the games
   * actually communicate.
   */
  function peerTargets() {
    if (deviceId === SCREEN) {
      return room.devices
        .map((d, slot) => (d && d.connected && slot !== SCREEN ? slot : null))
        .filter((slot) => slot !== null);
    }
    return [SCREEN];
  }

  function syncPeers() {
    const wanted = new Set(peerTargets());

    for (const [slot, peer] of peers) {
      if (!wanted.has(slot)) { peer.close(); peers.delete(slot); }
    }

    for (const slot of wanted) {
      if (peers.has(slot)) continue;
      peers.set(slot, connectPeer({
        roomCode,
        mySlot: deviceId,
        peerSlot: slot,
        onStateChange: (up) => {
          // Visible in the console and on window.__transport, so the fast path can be
          // confirmed rather than assumed.
          console.info(`[transport] slot ${slot}: ${up ? "DIRECT (webrtc)" : "relay (database)"}`);
          reportTransport();
        },
        onMessage: (msg) => {
          // Arrives exactly as a database message would, so the game sees no difference.
          if (deliverOnce(msg.seq)) return;
          if (bridge) bridge.pushMessage(msg.from, msg.data);
        },
      }));
    }
  }

  /**
   * Sends over the direct channel when it is available, otherwise through the database.
   *
   * `to === undefined` is a broadcast. Each recipient is tried individually so a mix of
   * connected and unconnected peers still works: the fast ones get it directly, and the
   * database carries only what is left.
   */
  let outSeq = 0;

  function routeMessage(to, data) {
    const seq = `${deviceId}:${outSeq++}`;
    const envelope = { from: deviceId, data, seq };
    // The database rules only allow from/to/data/at, so the tag travels inside data.
    const tagged = { __seq: seq, d: data };

    if (to === undefined || to === null) {
      const targets = peerTargets();
      const missed = targets.filter((slot) => {
        const peer = peers.get(slot);
        return !(peer && peer.send(envelope));
      });
      // Anyone we could not reach directly still gets it the slow way.
      if (missed.length) return sendMessage(roomCode, deviceId, undefined, tagged);
      return Promise.resolve();
    }

    const peer = peers.get(to);
    if (peer && peer.send(envelope)) return Promise.resolve();
    return sendMessage(roomCode, deviceId, to, tagged);
  }

  const actions = {
    sendMessage: (to, data) => routeMessage(to, data),
    setCustomState: (custom) => setCustomState(roomCode, deviceId, custom),
    navigate: (url) => navigate(roomCode, url),
    setActivePlayers: async (max) => {
      if (deviceId !== SCREEN) throw new Error("Only the screen can set active players.");
      const ids = await setActivePlayers(roomCode, room.devices, room.home, max);
      if (bridge) bridge.pushActivePlayers(ids);
    },
  };

  await attachDevice(roomCode, deviceId, { location: STORE_LOCATION, nickname });

  const session = {
    /** Which transport each peer is on, for diagnosing latency on a real device. */
    transport: () => reportTransport(),
    deviceId,
    roomCode,
    get room() { return room; },
    get isMaster() { return masterControllerId(room.devices, room.home) === deviceId; },
    get controllers() { return controllerIds(room.devices, room.home); },
    navigate: (url) => navigate(roomCode, url),
    navigateHome: () => navigate(roomCode, STORE_LOCATION),
    setCustomState: (custom) => setCustomState(roomCode, deviceId, custom),
    detach() {
      if (unwatchRoom) unwatchRoom();
      if (unwatchMessages) unwatchMessages();
      if (bridge) bridge.detach();
    },
  };

  /**
   * Loads the game for `home`, or clears the stage when this device shows the store.
   *
   * resolveUrl returns null for a location this device renders natively (the screen's
   * store page, the controller's store remote), so both shells share one code path.
   */
  function syncFrame() {
    if (room.home === loadedUrl) return;
    loadedUrl = room.home;

    if (bridge) { bridge.detach(); bridge = null; }
    // Remove only the game frame. The stage also contains shell-owned UI (the screen's
    // store, for one), and clearing it wholesale destroys elements the page still holds
    // references to.
    const previous = stage.querySelector("iframe.game-frame");
    if (previous) previous.remove();

    const src = resolveUrl(room.home);
    if (!src) {
      // A device at the store is still "somewhere": record it so presence and the derived
      // master stay accurate while nobody is in a game.
      setLocation(roomCode, deviceId, room.home).catch(() => {});
      return;
    }

    const frame = document.createElement("iframe");
    frame.className = "game-frame";
    frame.allow = isScreen
      ? "autoplay; fullscreen; gamepad"
      : "accelerometer; gyroscope; vibrate; autoplay";
    // Untrusted content: scripts yes, same-origin access to the shell no.
    frame.sandbox = "allow-scripts";
    frame.src = `${src}${src.includes("?") ? "&" : "?"}room=${roomCode}`;
    stage.appendChild(frame);

    bridge = attachGameFrame(frame, {
      roomCode,
      deviceId,
      location: room.home,
      getRoom: () => room,
      // The game reads this through getServerTime(). Measured asynchronously, so a frame
      // attached early gets 0 here and the real value via pushClock() moments later.
      clockOffset: () => clock.offset,
      actions,
    });

    // Record arrival at the new location, which is what makes onConnect fire for everyone
    // already there.
    setLocation(roomCode, deviceId, room.home).catch(() => {});
  }

  // Render once from what we already know, before the first snapshot arrives.
  //
  // Everything the shell draws hangs off onState, so until RTDB answers there is nothing on
  // screen at all. That is a blank stage on any slow connection, and a PERMANENTLY blank one
  // if the socket never opens - a failure mode with no visible symptom other than "it just
  // doesn't work". The room's opening state is already known here (the store, this device),
  // so paint it now and let the subscription correct it.
  if (onState) onState({ ...room, deviceId, isMaster: session.isMaster });

  unwatchRoom = watchRoom(
    roomCode,
    (next) => {
      room = next;
      syncFrame();
      syncPeers();
      if (bridge) bridge.pushDevices(room.devices);
      if (bridge) bridge.pushActivePlayers(activePlayerIds(room.devices));
      if (onState) onState({ ...room, deviceId, isMaster: session.isMaster });
    },
    (err) => {
      if (opts.onError) opts.onError(err);
    },
  );

  unwatchMessages = watchMessages(roomCode, deviceId, (from, data) => {
    // Unwrap the dedup tag. Messages from an older client arrive untagged and pass through.
    const tagged = data && typeof data === "object" && "__seq" in data;
    const seq = tagged ? data.__seq : null;
    const payload = tagged ? data.d : data;
    if (deliverOnce(seq)) return;
    if (bridge) bridge.pushMessage(from, payload);
  });

  return session;
}

export { SCREEN, STORE_LOCATION, gameUrl };
