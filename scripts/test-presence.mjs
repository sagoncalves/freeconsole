// Drives the real startSession path for a SCREEN against the emulator, rules enforced:
// createRoom -> claimSlot -> attachDevice (with onDisconnect). This is exactly what
// "Start a room" does, so it either reproduces the permission_denied or proves it fixed.
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import { getDatabase, ref, get, set, update, onDisconnect, connectDatabaseEmulator } from "firebase/database";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const PROJECT = "webconsole-8a62c";
let pass = 0, fail = 0;
const check = (n, ok, d="") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${ok?"":"\n        "+d}`); ok?pass++:fail++; };

function device(name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: "k", databaseURL: `http://127.0.0.1:9000?ns=${PROJECT}-default-rtdb` }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getDatabase(app); connectDatabaseEmulator(db, "127.0.0.1", 9000);
  const fn = getFunctions(app); connectFunctionsEmulator(fn, "127.0.0.1", 5001);
  return { auth, db, fn };
}

// Verbatim port of attachDevice() from public/room.js.
async function attachDevice(db, roomCode, slot, { location, nickname = null }) {
  const deviceRef = ref(db, `rooms/${roomCode}/devices/${slot}`);
  const existing = await get(deviceRef);
  await onDisconnect(deviceRef).update({ connected: false });
  await update(deviceRef, {
    location,
    connected: true,
    joinedAt: existing.exists() ? existing.val().joinedAt || Date.now() : Date.now(),
    nickname: nickname || (existing.exists() ? existing.val().nickname : null) || null,
  });
}

const screen = device("s"), phone = device("p");
const su = (await signInAnonymously(screen.auth)).user;
const pu = (await signInAnonymously(phone.auth)).user;

{
  const { default: admin } = await import("firebase-admin");
  const a = admin.initializeApp({ projectId: PROJECT }, "seed-presence");
  await admin.firestore(a).collection("games").doc("tapwar").set({ name:"Tap War", minPlayers:1, maxPlayers:8 });
}

const { data } = await httpsCallable(screen.fn, "createRoom")({});
const room = data.roomCode;

console.log("\nscreen opening a room (the failing path)");
try { await set(ref(screen.db, `rooms/${room}/uids/${su.uid}`), 0); check("screen claims slot 0", true); }
catch (e) { check("screen claims slot 0", false, e.message); }
try {
  await attachDevice(screen.db, room, 0, { location: "/store" });   // nickname omitted -> null
  check("screen attachDevice with null nickname", true);
} catch (e) { check("screen attachDevice with null nickname", false, e.message); }

console.log("\ncontroller joining");
try { await set(ref(phone.db, `rooms/${room}/uids/${pu.uid}`), 1); check("controller claims slot 1", true); }
catch (e) { check("controller claims slot 1", false, e.message); }
try {
  await attachDevice(phone.db, room, 1, { location: "/store", nickname: "Santi" });
  check("controller attachDevice with a nickname", true);
} catch (e) { check("controller attachDevice with a nickname", false, e.message); }

console.log("\nsetLocation, as session.js calls it right after attaching");
try {
  await update(ref(screen.db, `rooms/${room}/devices/0`), { location: "/store" });
  check("screen setLocation", true);
} catch (e) { check("screen setLocation", false, e.message); }
try {
  await update(ref(screen.db, `rooms/${room}/devices/0`), { location: "/games/roperaid/" });
  check("screen setLocation into a game", true);
} catch (e) { check("screen setLocation into a game", false, e.message); }

const devices = (await get(ref(screen.db, `rooms/${room}/devices`))).val() || {};
check("both devices present and connected",
  devices[0]?.connected === true && devices[1]?.connected === true, JSON.stringify(devices));
check("screen stored a null nickname", devices[0]?.nickname == null, JSON.stringify(devices[0]));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
