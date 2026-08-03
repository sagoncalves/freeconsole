/**
 * Direct peer-to-peer transport, the fast path for gameplay messages.
 *
 * Every message currently travels phone -> Firebase -> screen. Firebase's realtime database
 * is in the US, so a room in Uruguay pays a trans-continental round trip on every button
 * press: 200-300ms, when the two devices are metres apart on the same wifi.
 *
 * A WebRTC data channel connects them over the first network node they share - usually the
 * router in the room - so the traffic never leaves the building. That is 5-20ms instead of
 * 200-300ms, and it stops mattering where the players are.
 *
 * This is the same approach AirConsole takes, and for the same reason. Firebase is still
 * used to introduce the peers (signalling) and remains the fallback whenever a direct
 * connection cannot be established - restrictive mobile networks and symmetric NAT being
 * the usual causes. Nothing here changes the game-facing API: a message that arrives over
 * the data channel is indistinguishable from one that came through the database.
 */
import { getDatabase, ref, push, onChildAdded, remove, onValue }
  from "https://www.gstatic.com/firebasejs/11.1.0/firebase-database.js";
import { app } from "./relay.js?v=202608012300";

const db = getDatabase(app);

// Public STUN only. STUN just tells a peer its own public address so the two can find each
// other; it carries no game traffic. A TURN server would relay traffic when a direct path
// is impossible, but that costs money and bandwidth - the database fallback covers those
// cases instead, at the latency we already have today.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// How long to wait for a direct connection before giving up and staying on the database.
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Opens a data channel to one other device in the room.
 *
 * The device with the LOWER slot number is the offerer. That rule is arbitrary but it must
 * be consistent, or both sides create offers at once and neither connects ("glare").
 *
 * @param {object} opts
 * @param {string} opts.roomCode
 * @param {number} opts.mySlot        this device's slot
 * @param {number} opts.peerSlot      the slot to connect to
 * @param {(data:*) => void} opts.onMessage   called for each message that arrives
 * @param {(up:boolean) => void} [opts.onStateChange]  fired when the fast path opens/closes
 * @returns {{ send: (data:*) => boolean, isOpen: () => boolean, close: () => void }}
 */
export function connectPeer({ roomCode, mySlot, peerSlot, onMessage, onStateChange }) {
  const polite = mySlot > peerSlot;          // higher slot answers, lower slot offers
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  let channel = null;
  let open = false;
  let closed = false;
  const cleanups = [];

  const setOpen = (next) => {
    if (open === next) return;
    open = next;
    if (onStateChange) onStateChange(next);
  };

  const signalRef = (slot) => ref(db, `rooms/${roomCode}/signals/${slot}`);

  const sendSignal = (kind, payload) =>
    push(signalRef(peerSlot), {
      from: mySlot,
      kind,
      payload: JSON.stringify(payload),
      at: Date.now(),
    }).catch(() => {});

  /* ------------------------------------------------------------ data channel */

  const wireChannel = (ch) => {
    channel = ch;
    // Unordered and unreliable: a dropped input is better than a late one. Retransmitting a
    // button press that is already 100ms stale just delays every message behind it.
    ch.onopen = () => setOpen(true);
    ch.onclose = () => setOpen(false);
    ch.onerror = () => setOpen(false);
    ch.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
  };

  if (!polite) {
    // The offerer creates the channel; the answerer receives it via ondatachannel.
    wireChannel(pc.createDataChannel("game", {
      ordered: false,
      maxRetransmits: 0,
    }));
  } else {
    pc.ondatachannel = (e) => wireChannel(e.channel);
  }

  /* ------------------------------------------------------------ negotiation */

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal("ice", e.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setOpen(false);
    }
  };

  // Listen for anything addressed to us. Signals are deleted as they are consumed, so the
  // path does not accumulate.
  const stopSignals = onChildAdded(signalRef(mySlot), async (snap) => {
    const v = snap.val();
    if (!v || v.from !== peerSlot) return;
    remove(snap.ref).catch(() => {});

    let payload;
    try { payload = JSON.parse(v.payload); } catch { return; }

    try {
      if (v.kind === "offer") {
        await pc.setRemoteDescription(payload);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal("answer", answer);
      } else if (v.kind === "answer") {
        await pc.setRemoteDescription(payload);
      } else if (v.kind === "ice") {
        await pc.addIceCandidate(payload);
      }
    } catch { /* a failed negotiation just means we stay on the database */ }
  });
  cleanups.push(stopSignals);

  if (!polite) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal("offer", offer);
      } catch { /* stay on the database */ }
    })();
  }

  // Give up quietly if the connection never establishes.
  const timer = setTimeout(() => {
    if (!open) setOpen(false);
  }, CONNECT_TIMEOUT_MS);

  return {
    /** @returns {boolean} true if the message went out over the fast path. */
    send(data) {
      if (!open || !channel || channel.readyState !== "open") return false;
      try {
        channel.send(JSON.stringify(data));
        return true;
      } catch {
        return false;
      }
    },
    isOpen: () => open,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      cleanups.forEach((fn) => { try { fn(); } catch {} });
      try { if (channel) channel.close(); } catch {}
      try { pc.close(); } catch {}
      setOpen(false);
    },
  };
}

/**
 * Estimates the offset between this device's clock and the server's, and the round-trip
 * time to reach it.
 *
 * Two devices cannot compare timestamps directly - phone clocks are routinely seconds out,
 * which is what silently broke message ordering earlier in this project. Firebase publishes
 * its own measured offset at `.info/serverTimeOffset`, so `Date.now() + offset` is a clock
 * every device in the room agrees on.
 *
 * This is the same idea as AirConsole's "NTP in JavaScript": once each device knows how far
 * behind it is, the screen can correct for that delay rather than just suffering it.
 *
 * @returns {Promise<{offset:number, rtt:number}>}
 */
export function measureClock() {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;

    const finish = (offset) => {
      if (settled) return;
      settled = true;
      resolve({ offset: offset || 0, rtt: performance.now() - started });
    };

    // onValue fires SYNCHRONOUSLY when the value is already cached, so the callback can run
    // before `stop` has been assigned - a temporal dead zone error. Record the unsubscribe
    // in a mutable binding and call it defensively instead.
    let stop = null;
    try {
      stop = onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
        finish(snap.val());
        if (stop) stop();
      }, () => finish(0));
      // If the callback already fired synchronously, unsubscribe now.
      if (settled && stop) stop();
    } catch {
      finish(0);
    }

    // Never block startup on this.
    setTimeout(() => finish(0), 3000);
  });
}
