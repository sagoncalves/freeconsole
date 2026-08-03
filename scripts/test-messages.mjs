#!/usr/bin/env node
/**
 * Message delivery, including the clock-skew case that broke Rope Raid.
 *
 * The screen filtered incoming messages with `msg.at < subscribeTime`, where `at` came
 * from the SENDER's clock. A phone running a couple of seconds behind made every message
 * look like replayed history, so the screen silently discarded all input - the controller
 * showed "swinging" while nothing ever grappled.
 *
 * These tests send with deliberately wrong clocks and assert delivery regardless.
 */
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import {
  getDatabase, ref, set, get, push, query, limitToLast, onChildAdded, connectDatabaseEmulator,
} from "firebase/database";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const PROJECT = "webconsole-8a62c";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "\n        " + d}`); ok ? pass++ : fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function device(name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: "k", databaseURL: `http://127.0.0.1:9000?ns=${PROJECT}-default-rtdb` }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getDatabase(app); connectDatabaseEmulator(db, "127.0.0.1", 9000);
  const fn = getFunctions(app); connectFunctionsEmulator(fn, "127.0.0.1", 5001);
  return { auth, db, fn };
}

/** Port of watchMessages() from public/room.js. */
function watchMessages(db, roomCode, mySlot, callback) {
  const messagesRef = ref(db, `rooms/${roomCode}/messages`);
  const seen = new Set();
  let unsubscribe = null, stopped = false;

  get(messagesRef).then((snap) => {
    if (stopped) return;
    snap.forEach((child) => { seen.add(child.key); });
    unsubscribe = onChildAdded(query(messagesRef, limitToLast(60)), (childSnap) => {
      if (seen.has(childSnap.key)) return;
      seen.add(childSnap.key);
      const msg = childSnap.val();
      if (!msg) return;
      if (msg.from === mySlot) return;
      if (msg.to !== null && msg.to !== undefined && msg.to !== mySlot) return;
      callback(msg.from, msg.data);
    });
  });
  return () => { stopped = true; if (unsubscribe) unsubscribe(); };
}

const screen = device("s"), phone = device("p");
const su = (await signInAnonymously(screen.auth)).user;
const pu = (await signInAnonymously(phone.auth)).user;

{
  const { default: admin } = await import("firebase-admin");
  const a = admin.initializeApp({ projectId: PROJECT }, "seed-msg");
  await admin.firestore(a).collection("games").doc("tapwar").set({ name: "T", minPlayers: 1, maxPlayers: 8 });
}

const { data } = await httpsCallable(screen.fn, "createRoom")({});
const room = data.roomCode;
await set(ref(screen.db, `rooms/${room}/uids/${su.uid}`), 0);
await set(ref(phone.db, `rooms/${room}/uids/${pu.uid}`), 1);

// Pre-existing history the screen must NOT replay as live input.
await push(ref(phone.db, `rooms/${room}/messages`), { from: 1, to: 0, data: { hold: true }, at: Date.now() });
await wait(300);

const received = [];
const stop = watchMessages(screen.db, room, 0, (from, d) => received.push({ from, d }));
await wait(600);

console.log("\nhistory is not replayed as live input");
check("pre-existing message ignored", received.length === 0, JSON.stringify(received));

console.log("\ndelivery regardless of the sender's clock");
for (const [label, skew] of [["clock in sync", 0], ["phone 2s behind", -2000],
                             ["phone 30s behind", -30000], ["phone 5min behind", -300000],
                             ["phone 10s ahead", 10000]]) {
  const before = received.length;
  await push(ref(phone.db, `rooms/${room}/messages`), {
    from: 1, to: 0, data: { hold: true }, at: Date.now() + skew,
  });
  await wait(400);
  check(label, received.length === before + 1, `expected 1 new, got ${received.length - before}`);
}

console.log("\nrapid input is not dropped");
{
  const before = received.length;
  for (let i = 0; i < 8; i++) {
    await push(ref(phone.db, `rooms/${room}/messages`), {
      from: 1, to: 0, data: { hold: i % 2 === 0 }, at: Date.now() - 5000,
    });
  }
  await wait(900);
  check("all 8 rapid messages delivered", received.length === before + 8,
    `got ${received.length - before} of 8`);
}

console.log("\naddressing");
{
  const before = received.length;
  await push(ref(phone.db, `rooms/${room}/messages`), { from: 1, to: 9, data: {}, at: Date.now() });
  await wait(350);
  check("a message for another device is ignored", received.length === before);

  await push(ref(phone.db, `rooms/${room}/messages`), { from: 1, to: null, data: { b: 1 }, at: Date.now() });
  await wait(350);
  check("a broadcast is delivered", received.length === before + 1);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
