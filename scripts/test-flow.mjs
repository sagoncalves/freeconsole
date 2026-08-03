#!/usr/bin/env node
/**
 * End-to-end room lifecycle against the emulators, for the AirConsole model.
 *
 * The behaviours worth proving are the ones that changed when we adopted it:
 *   - device slots are positional and stable across a reconnect
 *   - the master controller is DERIVED (lowest connected controller), so migration is
 *     automatic and needs no write at all
 *   - navigation is a single `home` URL every device follows
 *   - custom device state is readable by everyone, including late joiners
 *
 * Run via scripts/test-flow.sh.
 */
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import { getDatabase, ref, get, set, update, connectDatabaseEmulator } from "firebase/database";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const PROJECT = "webconsole-8a62c";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
    failed++;
  }
}

function device(name) {
  const app = initializeApp(
    { projectId: PROJECT, apiKey: "fake-api-key", databaseURL: `http://127.0.0.1:9000?ns=${PROJECT}-default-rtdb` },
    name
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getDatabase(app);
  connectDatabaseEmulator(db, "127.0.0.1", 9000);
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, db, functions };
}

/* --- the derived master, mirroring room.js and the real AirConsole implementation --- */
const gameUrl = (url) => (url ? String(url).split("#")[0].split("?")[0] : "");

function masterControllerId(devices, location) {
  const target = gameUrl(location);
  for (let slot = 1; slot < devices.length; slot++) {
    const d = devices[slot];
    if (d && d.connected && gameUrl(d.location) === target) return slot;
  }
  return undefined;
}

async function readDevices(db, roomCode) {
  const snap = await get(ref(db, `rooms/${roomCode}/devices`));
  const devices = [];
  for (const [slot, d] of Object.entries(snap.val() || {})) devices[Number(slot)] = d;
  return devices;
}

const screen = device("screen");
const alice = device("alice");
const bob = device("bob");
const carol = device("carol");

console.log("\nsetup");
const screenUser = (await signInAnonymously(screen.auth)).user;
const aliceUser = (await signInAnonymously(alice.auth)).user;
const bobUser = (await signInAnonymously(bob.auth)).user;
const carolUser = (await signInAnonymously(carol.auth)).user;
check("four devices signed in", [screenUser, aliceUser, bobUser, carolUser].every((u) => u?.uid));

{
  const { default: adminPkg } = await import("firebase-admin");
  const adminApp = adminPkg.initializeApp({ projectId: PROJECT }, "seed");
  await adminPkg.firestore(adminApp).collection("games").doc("tapwar").set({
    name: "Tap War", minPlayers: 1, maxPlayers: 8,
    screenUrl: "/games/tapwar/screen.html",
    controllerUrl: "/games/tapwar/controller.html",
  });
}

console.log("\ncreateRoom");
const { data } = await httpsCallable(screen.functions, "createRoom")({});
const roomCode = data.roomCode;
check("returns a room code", /^[ACDEFGHJKLMNPQRTUVWXYZ2346789]{4}$/.test(roomCode || ""), String(roomCode));

const room = (await get(ref(screen.db, `rooms/${roomCode}`))).val();
check("room opens at the store", room?.home === "/store", String(room?.home));
check("the creating device is pre-assigned slot 0", room?.uids?.[screenUser.uid] === 0);
check("no host field exists - the master is derived", room?.hostUid === undefined);

console.log("\ndevice slots");
await update(ref(screen.db, `rooms/${roomCode}/devices/0`), {
  location: "/store", connected: true, joinedAt: Date.now(),
});
await set(ref(alice.db, `rooms/${roomCode}/uids/${aliceUser.uid}`), 1);
await update(ref(alice.db, `rooms/${roomCode}/devices/1`), {
  location: "/store", connected: true, joinedAt: Date.now(), nickname: "Alice",
});
await set(ref(bob.db, `rooms/${roomCode}/uids/${bobUser.uid}`), 2);
await update(ref(bob.db, `rooms/${roomCode}/devices/2`), {
  location: "/store", connected: true, joinedAt: Date.now(), nickname: "Bob",
});

{
  const devices = await readDevices(screen.db, roomCode);
  check("the screen holds slot 0", !!devices[0] && devices[0].connected === true);
  check("controllers hold slots 1 and 2", devices[1]?.nickname === "Alice" && devices[2]?.nickname === "Bob");
}

console.log("\nderived master controller");
{
  const devices = await readDevices(screen.db, roomCode);
  check("the first controller is master", masterControllerId(devices, "/store") === 1);
}
{
  // The whole point of deriving: the master leaves and the next controller simply IS the
  // master. No write, no transaction, no migration step.
  await update(ref(alice.db, `rooms/${roomCode}/devices/1`), { connected: false });
  const devices = await readDevices(screen.db, roomCode);
  check("master migrates automatically when it disconnects", masterControllerId(devices, "/store") === 2,
    `got ${masterControllerId(devices, "/store")}`);

  const hostField = (await get(ref(screen.db, `rooms/${roomCode}/hostUid`))).val();
  check("migration required no stored field", hostField === null);
}
{
  // Rejoining restores the original slot, so the first player gets the crown back.
  await update(ref(alice.db, `rooms/${roomCode}/devices/1`), { connected: true });
  const devices = await readDevices(screen.db, roomCode);
  check("master returns when the lower slot reconnects", masterControllerId(devices, "/store") === 1);
}
{
  const mapping = (await get(ref(alice.db, `rooms/${roomCode}/uids/${aliceUser.uid}`))).val();
  check("a device keeps its slot across a reconnect", mapping === 1, String(mapping));
}

console.log("\nnavigation");
{
  await set(ref(alice.db, `rooms/${roomCode}/home`), "/games/tapwar/");
  const home = (await get(ref(bob.db, `rooms/${roomCode}/home`))).val();
  check("navigateTo moves the whole room", home === "/games/tapwar/", String(home));
}
{
  // Devices follow by updating their own location; presence is per-location, which is what
  // makes onConnect/onDisconnect mean "entered/left this game".
  await update(ref(screen.db, `rooms/${roomCode}/devices/0`), { location: "/games/tapwar/" });
  await update(ref(alice.db, `rooms/${roomCode}/devices/1`), { location: "/games/tapwar/" });

  const devices = await readDevices(screen.db, roomCode);
  check("master is derived per-location", masterControllerId(devices, "/games/tapwar/") === 1);
  check("a device still at the store isn't in the game",
    masterControllerId(devices, "/games/tapwar/") !== 2);
}
{
  await set(ref(alice.db, `rooms/${roomCode}/home`), "/store");
  const home = (await get(ref(screen.db, `rooms/${roomCode}/home`))).val();
  check("navigateHome returns the room to the store", home === "/store");
}

console.log("\ncustom device state");
{
  await set(ref(alice.db, `rooms/${roomCode}/devices/1/custom`), { browsing: "tapwar" });
  const seenByBob = (await get(ref(bob.db, `rooms/${roomCode}/devices/1/custom`))).val();
  check("custom state is readable by other devices", seenByBob?.browsing === "tapwar", JSON.stringify(seenByBob));
}
{
  // A device joining now still sees state published before it arrived - the property that
  // makes custom state, not broadcasts, the right home for anything durable.
  await set(ref(carol.db, `rooms/${roomCode}/uids/${carolUser.uid}`), 3);
  await update(ref(carol.db, `rooms/${roomCode}/devices/3`), {
    location: "/store", connected: true, joinedAt: Date.now(), nickname: "Carol",
  });
  const seenByLateJoiner = (await get(ref(carol.db, `rooms/${roomCode}/devices/1/custom`))).val();
  check("a late joiner sees existing custom state", seenByLateJoiner?.browsing === "tapwar");
}

console.log("\nactive players");
{
  // setActivePlayers is the screen's job: assign consecutive numbers from 0.
  const devices = await readDevices(screen.db, roomCode);
  const ids = [];
  for (let slot = 1; slot < devices.length; slot++) {
    const d = devices[slot];
    if (d && d.connected && gameUrl(d.location) === "/store") ids.push(slot);
  }
  const updates = {};
  ids.forEach((slot, index) => { updates[`${slot}/playerNumber`] = index; });
  await update(ref(screen.db, `rooms/${roomCode}/devices`), updates);

  const after = await readDevices(screen.db, roomCode);
  const numbers = ids.map((slot) => after[slot].playerNumber);
  check("player numbers are consecutive from 0",
    numbers.every((n, i) => n === i), JSON.stringify(numbers));
  check("player numbers map back to device ids", after[ids[0]].playerNumber === 0);
}

console.log("\nmessaging");
{
  await set(ref(screen.db, `rooms/${roomCode}/messages/m1`), {
    from: 0, to: null, data: { phase: "play" }, at: Date.now(),
  });
  const msg = (await get(ref(alice.db, `rooms/${roomCode}/messages/m1`))).val();
  check("a broadcast reaches other devices", msg?.data?.phase === "play", JSON.stringify(msg));
}
{
  await set(ref(alice.db, `rooms/${roomCode}/messages/m2`), {
    from: 1, to: 0, data: { seq: 7 }, at: Date.now(),
  });
  const msg = (await get(ref(screen.db, `rooms/${roomCode}/messages/m2`))).val();
  check("a directed message carries sender and recipient", msg?.from === 1 && msg?.to === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
