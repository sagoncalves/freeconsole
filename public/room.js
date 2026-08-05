/**
 * Room session: device slots, presence, navigation, and messaging.
 *
 * This is the Firebase half of the FreeConsole model. The SDK (sdk.js) presents the API to
 * games; this module implements it against RTDB and is the only code holding a Firebase
 * connection.
 *
 * Two ideas carry the whole design, both taken from FreeConsole:
 *
 *   Slots. Every device claims a numbered slot for the life of the room. The screen is
 *   always 0. A device keeps its slot across disconnect/reconnect, so device ids are stable.
 *
 *   Location. Every device records the URL it's on. "Who is in my game" is just "who shares
 *   my location", which makes onConnect/onDisconnect fall out for free — and means the
 *   master controller can be *derived* (lowest connected controller) instead of stored.
 *   No host field, no claim transaction, no migration.
 */
import {
  ref,
  get,
  set,
  update,
  push,
  onValue,
  onChildAdded,
  onDisconnect,
  runTransaction,
  query,
  limitToLast,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-database.js";
import { db } from "./relay.js?v=202608012300";

export const SCREEN = 0;
export const STORE_LOCATION = "/store";

/** Strips hash and query, the way FreeConsole compares game URLs. */
export function gameUrl(url) {
  if (!url) return "";
  return String(url).split("#")[0].split("?")[0];
}

/**
 * Claims this device's slot, or returns the one it already holds.
 *
 * The screen passes 0 explicitly; controllers get the lowest free slot. The uid→slot
 * mapping is written once and never changed, which is what makes device ids stable across
 * a reconnect.
 */
export async function claimSlot(roomCode, uid, { screen = false } = {}) {
  const mappingRef = ref(db, `rooms/${roomCode}/uids/${uid}`);
  const existing = await get(mappingRef);
  if (existing.exists()) return existing.val();

  if (screen) {
    await set(mappingRef, SCREEN);
    return SCREEN;
  }

  // Claim the lowest free controller slot.
  //
  // The write must target uids/{uid} specifically: the security rules only grant a device
  // its own key, so writing the whole uids map (even inside a transaction) is denied.
  //
  // That means the "is this slot free?" check can't live in the transaction, so instead we
  // read the map, claim a slot, and re-check. If someone took the same number in between,
  // their write landed first and ours is a duplicate - we release it and retry with the
  // next free number.
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await get(ref(db, `rooms/${roomCode}/uids`));
    const taken = new Map(Object.entries(snapshot.val() || {}));

    // Someone may have claimed on our behalf between the two reads.
    if (taken.has(uid)) return taken.get(uid);

    const used = new Set(taken.values());
    let slot = SCREEN + 1;
    while (used.has(slot)) slot++;

    await set(mappingRef, slot);

    // Confirm we're the only holder of that number.
    const after = await get(ref(db, `rooms/${roomCode}/uids`));
    const holders = Object.entries(after.val() || {}).filter(([, s]) => s === slot);
    if (holders.length === 1) return slot;

    // A tie: lowest uid keeps it, everyone else releases and tries again. Deterministic,
    // so both sides agree without needing another round trip.
    const winner = holders.map(([who]) => who).sort()[0];
    if (winner === uid) return slot;
    await set(mappingRef, null);
  }

  throw new Error("Could not claim a device slot.");
}

/**
 * Registers presence for a slot and keeps it accurate.
 *
 * onDisconnect flips `connected` the moment the socket drops, which is also what makes
 * master migration automatic: the derived master simply skips disconnected devices.
 */
export async function attachDevice(roomCode, slot, { location, nickname = null }) {
  const deviceRef = ref(db, `rooms/${roomCode}/devices/${slot}`);
  const existing = await get(deviceRef);

  const presence = {
    location,
    connected: true,
    joinedAt: existing.exists() ? existing.val().joinedAt || Date.now() : Date.now(),
    nickname: nickname || (existing.exists() ? existing.val().nickname : null) || null,
  };

  // The write is authorised by uids/{uid} === slot. For a screen that mapping is written
  // server-side by createRoom, so the client can briefly evaluate the rule before it has
  // that value locally and get permission_denied - which also drops the onDisconnect and
  // leaves the room with a claimed uid but no device. Retry briefly: the mapping is
  // guaranteed to exist, so this converges rather than masking a real denial.
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await onDisconnect(deviceRef).update({ connected: false });
      await update(deviceRef, presence);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Moves this device to a new location (i.e. loads a different game). */
export async function setLocation(roomCode, slot, location) {
  await update(ref(db, `rooms/${roomCode}/devices/${slot}`), { location });
}

/** Publishes this device's custom state — the late-joiner-safe sync primitive. */
export async function setCustomState(roomCode, slot, custom) {
  // Written longhand, not with `??`. Files in public/ are served verbatim - Vite treats
  // them as external so their URLs stay literal for the game iframes - which means ES2020
  // syntax reaches the client uncompiled. Smart-TV browsers on old Chromium fail to PARSE
  // it, killing this whole module and every page that imports it before a line runs.
  await set(
    ref(db, `rooms/${roomCode}/devices/${slot}/custom`),
    custom === null || custom === undefined ? null : custom,
  );
}

/**
 * navigateTo: asks every device to load a game.
 *
 * Writing `home` is the entire navigation state machine — every device watches it and
 * follows. Passing null sends everyone back to the store, i.e. navigateHome().
 */
export async function navigate(roomCode, url) {
  await set(ref(db, `rooms/${roomCode}/home`), url || STORE_LOCATION);
}

/**
 * Subscribes to the room. Fires with { home, devices } on every change.
 *
 * `onError` matters as much as the value callback. Without it a rejected read - permission
 * denied, or a socket the browser never manages to open - is COMPLETELY silent: the value
 * callback simply never fires, so whatever the caller renders from room state never renders
 * at all. On a screen that means the shell paints its chrome and then shows an empty stage
 * forever, with nothing logged anywhere to say why.
 */
export function watchRoom(roomCode, callback, onError) {
  return onValue(
    ref(db, `rooms/${roomCode}`),
    (snap) => {
      const room = snap.val();
      if (!room) return;

      // RTDB returns a sparse object for numeric keys; normalise to a dense array indexed by
      // slot so `devices[device_id]` works the way the SDK expects.
      const devices = [];
      for (const [slot, device] of Object.entries(room.devices || {})) {
        devices[Number(slot)] = device;
      }

      callback({ home: room.home || STORE_LOCATION, devices });
    },
    (err) => {
      console.error("[room] watch failed", err);
      if (onError) onError(err);
    },
  );
}

/**
 * The master controller: lowest-numbered connected controller at `location`.
 *
 * Derived, never stored — the single most important detail of the FreeConsole model. When
 * the master leaves, the next controller *is* the master with no write and no handover.
 */
export function masterControllerId(devices, location) {
  const target = gameUrl(location);
  for (let slot = SCREEN + 1; slot < devices.length; slot++) {
    const device = devices[slot];
    if (device && device.connected && gameUrl(device.location) === target) return slot;
  }
  return undefined;
}

/** Device ids of controllers sharing `location`. */
export function controllerIds(devices, location) {
  const target = gameUrl(location);
  const result = [];
  for (let slot = SCREEN + 1; slot < devices.length; slot++) {
    const device = devices[slot];
    if (device && device.connected && gameUrl(device.location) === target) result.push(slot);
  }
  return result;
}

/* ---------------------------------------------------------------- messaging */

/**
 * Sends a message. `to` of null broadcasts to everyone.
 *
 * Messages are transient by design - a late joiner reads custom device state, not history.
 * A game broadcasting at 10Hz would otherwise pile up thousands of nodes per race, so the
 * sender trims its own trail periodically.
 */
let sinceTrim = 0;

export async function sendMessage(roomCode, fromSlot, to, data) {
  await push(ref(db, `rooms/${roomCode}/messages`), {
    from: fromSlot,
    to: to === undefined ? null : to,
    data: data === null || data === undefined ? null : data,
    at: Date.now(),
  });

  // Trim occasionally rather than on every send: one extra read/write per ~120 messages
  // is negligible next to the cost of letting the list grow without bound.
  if (++sinceTrim >= 120) {
    sinceTrim = 0;
    trimMessages(roomCode).catch(() => {});
  }
}

/** Drops all but the most recent messages, so a long session can't grow without limit. */
async function trimMessages(roomCode, keep = 60) {
  const messagesRef = ref(db, `rooms/${roomCode}/messages`);
  const snap = await get(messagesRef);
  const all = snap.val();
  if (!all) return;

  const keys = Object.keys(all);
  if (keys.length <= keep) return;

  // push() keys sort chronologically, so the oldest are simply the first.
  keys.sort();
  const updates = {};
  for (const key of keys.slice(0, keys.length - keep)) updates[key] = null;
  await update(messagesRef, updates);
}

/**
 * Subscribes to messages addressed to this device.
 *
 * Only the tail is read: a device joining mid-session wants what happens next, not the
 * whole history. Anything a late joiner genuinely needs belongs in custom device state,
 * which is replayed by design.
 */
export function watchMessages(roomCode, mySlot, callback) {
  // onChildAdded replays existing children when it attaches, so the first burst is
  // history that belongs to whatever happened before this device arrived.
  //
  // Do NOT filter that by comparing timestamps: `at` is Date.now() on the SENDER, and a
  // phone whose clock is a couple of seconds behind the screen makes every message look
  // older than the subscription - silently dropping ALL input, which is exactly the bug
  // that made grappling do nothing. Client clocks cannot be trusted for ordering.
  //
  // Instead, skip whatever exists at attach time and accept everything after. push()
  // keys are chronological and server-generated, so "arrived after we subscribed" is a
  // property of delivery order, not of any clock.
  const messagesRef = ref(db, `rooms/${roomCode}/messages`);
  const seen = new Set();
  let unsubscribe = null;
  let stopped = false;

  // Record the keys that already exist, THEN subscribe. Anything with a key we haven't
  // recorded is new, regardless of any clock. Deterministic: no timing window where a
  // real message could be mistaken for history.
  get(messagesRef).then((snap) => {
    if (stopped) return;
    snap.forEach((child) => { seen.add(child.key); });

    unsubscribe = onChildAdded(query(messagesRef, limitToLast(60)), (childSnap) => {
      if (seen.has(childSnap.key)) return;
      seen.add(childSnap.key);
      // The set only needs to cover the trim window; drop the oldest so it can't grow
      // without bound over a long session.
      if (seen.size > 400) {
        const oldest = seen.values().next().value;
        seen.delete(oldest);
      }

      const msg = childSnap.val();
      if (!msg) return;
      if (msg.from === mySlot) return;                            // never echo the sender
      if (msg.to !== null && msg.to !== undefined && msg.to !== mySlot) return;
      callback(msg.from, msg.data);
    });
  });

  return () => {
    stopped = true;
    if (unsubscribe) unsubscribe();
  };
}

/** Assigns consecutive player numbers to connected controllers. Screen only. */
export async function setActivePlayers(roomCode, devices, location, max) {
  const ids = controllerIds(devices, location);
  const chosen = max > 0 ? ids.slice(0, max) : max === 0 ? [] : ids;

  const updates = {};
  for (let slot = SCREEN + 1; slot < devices.length; slot++) {
    if (!devices[slot]) continue;
    const index = chosen.indexOf(slot);
    updates[`${slot}/playerNumber`] = index === -1 ? null : index;
  }
  if (Object.keys(updates).length) {
    await update(ref(db, `rooms/${roomCode}/devices`), updates);
  }
  return chosen;
}

/** Active players in player-number order, read back off the device table. */
export function activePlayerIds(devices) {
  const withNumbers = [];
  for (let slot = SCREEN + 1; slot < devices.length; slot++) {
    const device = devices[slot];
    if (device && typeof device.playerNumber === "number") {
      withNumbers.push([device.playerNumber, slot]);
    }
  }
  return withNumbers.sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
}

export { serverTimestamp };
