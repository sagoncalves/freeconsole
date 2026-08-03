#!/usr/bin/env node
/**
 * Tests the email-auth admin flow against the emulators.
 *
 * The point of these tests is that the "create as admin" checkbox is only a UI hint: the
 * real gate is claimFirstAdmin, which must reject a second claimant even when called
 * directly, bypassing the page entirely. Also asserts that catalog writes require the
 * admin claim and that the shape validation in firestore.rules holds.
 *
 * Run via scripts/test-admin-auth.sh.
 */
import { initializeApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInAnonymously,
  connectAuthEmulator,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  connectFirestoreEmulator,
} from "firebase/firestore";
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} from "firebase/functions";

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

// Each user is a separate browser in reality, so give each its own app instance.
function device(name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: "fake-api-key" }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, firestore, functions };
}

const stamp = Date.now();
const alice = device("alice");   // becomes the first admin
const bob = device("bob");       // a second person who tries to claim it too
const anon = device("anon");     // an anonymous player session

const VALID_GAME = {
  name: "Test Game",
  description: "from the admin auth test",
  minPlayers: 2,
  maxPlayers: 4,
  screenUrl: "/games/testgame/screen.html",
  controllerUrl: "/games/testgame/controller.html",
  thumbnailUrl: null,
};

async function fails(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

console.log("\nbootstrap state");
{
  const snap = await getDoc(doc(alice.firestore, "admin_meta", "state"));
  const exists = snap.exists() && snap.data().adminExists === true;
  check("no admin exists yet, so the bootstrap is open", !exists, JSON.stringify(snap.data()));
}

console.log("\nfirst admin claim");
await createUserWithEmailAndPassword(alice.auth, `alice+${stamp}@example.com`, "hunter2pass");
{
  const { data } = await httpsCallable(alice.functions, "claimFirstAdmin")({});
  check("first email user claims admin", data.admin === true, JSON.stringify(data));

  await alice.auth.currentUser.getIdToken(true);
  const token = await alice.auth.currentUser.getIdTokenResult();
  check("claim lands in the ID token after refresh", token.claims.admin === true, JSON.stringify(token.claims));
}
{
  const snap = await getDoc(doc(alice.firestore, "admin_meta", "state"));
  check("admin_meta now records an admin", snap.data()?.adminExists === true);
}

console.log("\nbootstrap is closed afterwards");
await createUserWithEmailAndPassword(bob.auth, `bob+${stamp}@example.com`, "hunter2pass");
{
  // Bob calls the function directly - exactly what someone would do after noticing the
  // checkbox is hidden. The server must still refuse.
  const err = await fails(httpsCallable(bob.functions, "claimFirstAdmin")({}));
  check("a second user cannot claim admin", !!err, "the call unexpectedly succeeded");

  await bob.auth.currentUser.getIdToken(true);
  const token = await bob.auth.currentUser.getIdTokenResult();
  check("the rejected user has no admin claim", token.claims.admin !== true, JSON.stringify(token.claims));
}
{
  await signInAnonymously(anon.auth);
  const err = await fails(httpsCallable(anon.functions, "claimFirstAdmin")({}));
  check("an anonymous session cannot claim admin", !!err);
}

console.log("\ncatalog writes require the admin claim");
{
  const err = await fails(setDoc(doc(bob.firestore, "games", `bobgame-${stamp}`), VALID_GAME));
  check("a signed-in non-admin cannot write the catalog", err?.code === "permission-denied", String(err?.code));
}
{
  const err = await fails(setDoc(doc(anon.firestore, "games", `anongame-${stamp}`), VALID_GAME));
  check("an anonymous player cannot write the catalog", err?.code === "permission-denied", String(err?.code));
}
{
  const err = await fails(setDoc(doc(bob.firestore, "admin_meta", "state"), { adminExists: false }));
  check("nobody can reset admin_meta to reopen the bootstrap", err?.code === "permission-denied", String(err?.code));
}

console.log("\nadmin can manage the catalog");
const gameId = `testgame-${stamp}`;
{
  const err = await fails(setDoc(doc(alice.firestore, "games", gameId), VALID_GAME));
  check("admin creates a game", !err, String(err?.message));
}
{
  const snap = await getDoc(doc(anon.firestore, "games", gameId));
  check("the catalog stays world-readable", snap.exists() && snap.data().name === "Test Game");
}
{
  const err = await fails(
    setDoc(doc(alice.firestore, "games", gameId), { ...VALID_GAME, name: "Renamed" }, { merge: true })
  );
  check("admin edits a game", !err, String(err?.message));
}

console.log("\nrules reject malformed entries");
const invalid = [
  ["a javascript: screenUrl", { screenUrl: "javascript:alert(1)" }],
  ["a data: screenUrl", { screenUrl: "data:text/html,<script>alert(1)</script>" }],
  ["a protocol-relative URL", { screenUrl: "//evil.example.com/s.html" }],
  ["a plain http:// URL", { screenUrl: "http://insecure.example.com/s.html" }],
  ["an empty name", { name: "" }],
  ["maxPlayers below minPlayers", { minPlayers: 5, maxPlayers: 2 }],
  ["minPlayers of zero", { minPlayers: 0 }],
];
for (const [label, override] of invalid) {
  const err = await fails(
    setDoc(doc(alice.firestore, "games", `bad-${stamp}`), { ...VALID_GAME, ...override })
  );
  check(`rejects ${label}`, err?.code === "permission-denied", `got ${err?.code || "success"}`);
}

console.log("\ngranting admin to someone else");
{
  const err = await fails(
    httpsCallable(bob.functions, "grantAdmin")({ email: `bob+${stamp}@example.com` })
  );
  check("a non-admin cannot grant admin", !!err);
}
{
  const { data } = await httpsCallable(alice.functions, "grantAdmin")({
    email: `bob+${stamp}@example.com`,
  });
  check("an admin can grant admin", data.admin === true, JSON.stringify(data));

  await bob.auth.currentUser.getIdToken(true);
  const token = await bob.auth.currentUser.getIdTokenResult();
  check("the promoted user gains the claim", token.claims.admin === true);

  const err = await fails(setDoc(doc(bob.firestore, "games", `bobgame2-${stamp}`), VALID_GAME));
  check("the promoted user can now write the catalog", !err, String(err?.message));
  await fails(deleteDoc(doc(bob.firestore, "games", `bobgame2-${stamp}`)));
}
{
  const err = await fails(
    httpsCallable(alice.functions, "grantAdmin")({ email: "nobody@example.com" })
  );
  check("granting to a nonexistent account fails", !!err);
}

console.log("\ndeletion");
{
  const err = await fails(deleteDoc(doc(alice.firestore, "games", gameId)));
  check("admin deletes a game", !err, String(err?.message));
  const snap = await getDoc(doc(alice.firestore, "games", gameId));
  check("the game is gone", !snap.exists());
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
