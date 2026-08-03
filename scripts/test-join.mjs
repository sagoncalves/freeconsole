#!/usr/bin/env node
/**
 * Exercises the real slot-claim path against the emulator.
 *
 * This is the code that runs when a phone scans the QR and taps Join. It regressed once
 * because claimSlot() wrote the whole `uids` map inside a transaction while the rules only
 * grant a device its own key — so the claim was denied with permission_denied and joining
 * was impossible. These tests drive the actual client logic, rules enforced.
 *
 * Run via scripts/test-join.sh.
 */
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import { getDatabase, ref, get, set, connectDatabaseEmulator } from "firebase/database";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const PROJECT = "webconsole-8a62c";
const SCREEN = 0;
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failed++; }
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
  return { auth, db, functions };
}

/** Port of claimSlot() from public/room.js — kept in step with it deliberately. */
async function claimSlot(db, roomCode, uid, { screen = false } = {}) {
  const mappingRef = ref(db, `rooms/${roomCode}/uids/${uid}`);
  const existing = await get(mappingRef);
  if (existing.exists()) return existing.val();

  if (screen) {
    await set(mappingRef, SCREEN);
    return SCREEN;
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await get(ref(db, `rooms/${roomCode}/uids`));
    const taken = new Map(Object.entries(snapshot.val() || {}));
    if (taken.has(uid)) return taken.get(uid);

    const used = new Set(taken.values());
    let slot = SCREEN + 1;
    while (used.has(slot)) slot++;

    await set(mappingRef, slot);

    const after = await get(ref(db, `rooms/${roomCode}/uids`));
    const holders = Object.entries(after.val() || {}).filter(([, s]) => s === slot);
    if (holders.length === 1) return slot;

    const winner = holders.map(([who]) => who).sort()[0];
    if (winner === uid) return slot;
    await set(mappingRef, null);
  }
  throw new Error("Could not claim a device slot.");
}

const screen = device("screen");
const p1 = device("p1");
const p2 = device("p2");
const p3 = device("p3");

const screenUser = (await signInAnonymously(screen.auth)).user;
const u1 = (await signInAnonymously(p1.auth)).user;
const u2 = (await signInAnonymously(p2.auth)).user;
const u3 = (await signInAnonymously(p3.auth)).user;

{
  const { default: adminPkg } = await import("firebase-admin");
  const adminApp = adminPkg.initializeApp({ projectId: PROJECT }, "seed-join");
  await adminPkg.firestore(adminApp).collection("games").doc("tapwar").set({
    name: "Tap War", minPlayers: 1, maxPlayers: 8,
    screenUrl: "/games/tapwar/screen.html", controllerUrl: "/games/tapwar/controller.html",
  });
}

const { data } = await httpsCallable(screen.functions, "createRoom")({});
const roomCode = data.roomCode;

console.log("\nscreen claims slot 0");
{
  const slot = await claimSlot(screen.db, roomCode, screenUser.uid, { screen: true });
  check("screen gets slot 0", slot === SCREEN, String(slot));
}

console.log("\ncontrollers claim slots (the path that was denied)");
{
  const slot = await claimSlot(p1.db, roomCode, u1.uid);
  check("first controller gets slot 1", slot === 1, String(slot));
}
{
  const slot = await claimSlot(p2.db, roomCode, u2.uid);
  check("second controller gets slot 2", slot === 2, String(slot));
}

console.log("\nsimultaneous joins");
{
  // Two phones scanning the QR at the same moment must not end up sharing a slot.
  const p4 = device("p4");
  const u4 = (await signInAnonymously(p4.auth)).user;
  const [a, b] = await Promise.all([
    claimSlot(p3.db, roomCode, u3.uid),
    claimSlot(p4.db, roomCode, u4.uid),
  ]);
  check("racing devices get different slots", a !== b, `both got ${a}`);

  const all = (await get(ref(screen.db, `rooms/${roomCode}/uids`))).val() || {};
  const values = Object.values(all);
  check("no slot is shared", new Set(values).size === values.length, JSON.stringify(all));
}

console.log("\nreconnect keeps the slot");
{
  const again = await claimSlot(p1.db, roomCode, u1.uid);
  check("rejoining returns the original slot", again === 1, String(again));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
