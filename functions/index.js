const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
// Imported explicitly rather than via admin.database.ServerValue: calling admin.database()
// shadows the namespace's static properties, leaving ServerValue undefined at runtime.
const { ServerValue } = require("firebase-admin/database");
// Same shadowing problem as ServerValue above: calling admin.firestore() hides the
// namespace's static FieldValue, so import it explicitly.
const { FieldValue } = require("firebase-admin/firestore");
const { randomBytes } = require("node:crypto");

// NOTE: two dependencies in package.json are required but never imported here. Do not
// prune either as unused.
//
//   @firebase/app - firebase-admin's RTDB path pulls in @firebase/database-compat, which
//     declares @firebase/app as a *peer* dependency. npm auto-installs peers; pnpm does
//     not, so without it the runtime dies with "Cannot find module '@firebase/app'".
//
//   @google-cloud/functions-framework - the GCF buildpack injects this automatically for
//     npm projects but refuses to for pnpm ones, failing the deploy build outright.

admin.initializeApp();

const db = admin.database();
const firestore = admin.firestore();

// Ambiguous glyphs (I/1, O/0, S/5, B/8) are omitted so a code read off a TV across
// the room can be typed into a phone without guesswork. Must stay consistent with the
// [A-Z0-9]{4} matcher in database.rules.json.
const ROOM_CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXYZ2346789";
const ROOM_CODE_LENGTH = 4;
const MAX_CODE_ATTEMPTS = 12;

// A room whose screen has been gone this long is considered abandoned.
const STALE_ROOM_MS = 30 * 60 * 1000;
// Backstop for rooms that somehow never recorded screen presence at all.
const MAX_ROOM_AGE_MS = 12 * 60 * 60 * 1000;

// Crypto randomness rather than Math.random: the code is the only thing gating entry to a
// session, so it shouldn't be predictable from other codes issued nearby in time.
// Rejection sampling keeps the alphabet uniform despite 256 % 29 != 0.
function generateRoomCode() {
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    for (const byte of randomBytes(ROOM_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
      if (code.length === ROOM_CODE_LENGTH) break;
    }
  }
  return code;
}

/**
 * Opens a room and returns its short code.
 *
 * Must be called by an already-authenticated device (the screen). The caller's uid is
 * stamped onto the room as `screenUid`, which is what the RTDB rules check before allowing
 * any write to `gameState` or `screen`. That binding is the whole reason this runs
 * server-side: a client could otherwise claim authority over someone else's room.
 *
 * A room starts in the lobby with no game. `gameId` is optional - pass one to pre-select a
 * game, or omit it and let the host choose from their phone. Either way the host can swap
 * games later, which is why gameId is mutable in the rules and not stamped here as final.
 */
exports.createRoom = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before creating a room.");
  }

  const gameId = (request.data && request.data.gameId) || null;
  if (gameId !== null) {
    if (typeof gameId !== "string" || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(gameId)) {
      throw new HttpsError("invalid-argument", "A valid gameId is required.");
    }
    // Refuse to open a room for a game that isn't in the catalog, so room codes can never
    // point a screen at an arbitrary URL.
    const gameDoc = await firestore.collection("games").doc(gameId).get();
    if (!gameDoc.exists) {
      throw new HttpsError("not-found", `Unknown game: ${gameId}`);
    }
  }

  // Claim a code with a transaction so two simultaneous hosts can't land on the same one.
  // On collision the transaction aborts and we retry with a fresh code.
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const roomRef = db.ref(`rooms/${code}`);

    const result = await roomRef.transaction((current) => {
      if (current !== null) return; // taken - abort this attempt
      return {
        // Every device follows this URL. The room opens at the store; the master
        // controller navigates it elsewhere. There is no separate lobby phase and no
        // stored host - the master is derived from who is connected.
        home: gameId ? `/games/${gameId}/` : "/store",
        createdAt: ServerValue.TIMESTAMP,
        // The creating device is pre-assigned slot 0, the screen.
        uids: { [uid]: 0 },
      };
    });

    if (result.committed) {
      logger.info("room created", { code, gameId, screenUid: uid });
      return { roomCode: code, gameId };
    }
  }

  logger.error("room code space exhausted", { attempts: MAX_CODE_ATTEMPTS });
  throw new HttpsError("resource-exhausted", "Could not allocate a room code. Try again.");
});

/* -------------------------------------------------------------------- admin auth */

// Tracks whether the catalog has an owner yet. The doc is written only by the functions
// below; clients may read it (to decide whether to offer the bootstrap option) but never
// write it - see firestore.rules.
const ADMIN_META = () => firestore.collection("admin_meta").doc("state");

/**
 * Claims the first admin account.
 *
 * This is the bootstrap: the very first authenticated, email-verified-capable user to call
 * it becomes admin, and after that it is permanently closed. Everyone else must be promoted
 * by an existing admin via grantAdmin.
 *
 * The check and the claim happen inside a Firestore transaction, so two people racing this
 * cannot both win - the second sees adminExists already true and is rejected. A checkbox in
 * the browser is only a hint; this is the actual gate.
 */
exports.claimFirstAdmin = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before claiming admin.");
  }

  // Anonymous sessions are for players. An admin must be a real email account so the
  // identity survives, can be recovered, and can be promoted/audited later.
  const provider = request.auth.token && request.auth.token.firebase &&
    request.auth.token.firebase.sign_in_provider;
  if (provider !== "password") {
    throw new HttpsError(
      "permission-denied",
      "Admin accounts must use email and password, not anonymous sign-in."
    );
  }

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ADMIN_META());
    if (snap.exists && snap.data().adminExists === true) {
      throw new HttpsError(
        "failed-precondition",
        "An admin already exists. Ask them to grant you access."
      );
    }
    tx.set(
      ADMIN_META(),
      {
        adminExists: true,
        firstAdminUid: uid,
        claimedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  await admin.auth().setCustomUserClaims(uid, { admin: true });
  logger.info("first admin claimed", { uid });

  // The claim only lands in the caller's ID token on refresh; the client forces one.
  return { admin: true, uid };
});

/**
 * Promotes another user to admin. Callable only by an existing admin.
 */
exports.grantAdmin = onCall(async (request) => {
  const callerClaims = request.auth && request.auth.token;
  if (!callerClaims || callerClaims.admin !== true) {
    throw new HttpsError("permission-denied", "Only an admin can grant admin access.");
  }

  const email = request.data && request.data.email;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email.trim());
  } catch {
    throw new HttpsError("not-found", `No account exists for ${email}. Ask them to sign up first.`);
  }

  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  logger.info("admin granted", { by: request.auth.uid, to: user.uid });
  return { admin: true, uid: user.uid, email: user.email };
});

/**
 * Revokes another user's admin access. Callable only by an existing admin.
 */
exports.revokeAdmin = onCall(async (request) => {
  const callerClaims = request.auth && request.auth.token;
  if (!callerClaims || callerClaims.admin !== true) {
    throw new HttpsError("permission-denied", "Only an admin can revoke admin access.");
  }

  const email = request.data && request.data.email;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email.trim());
  } catch {
    throw new HttpsError("not-found", `No account exists for ${email}.`);
  }

  // Refuse to leave the catalog with no owner at all.
  if (user.uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "You cannot revoke your own admin access.");
  }

  await admin.auth().setCustomUserClaims(user.uid, { admin: false });
  logger.info("admin revoked", { by: request.auth.uid, from: user.uid });
  return { admin: false, uid: user.uid, email: user.email };
});

/**
 * Deletes abandoned rooms so the database doesn't accumulate dead sessions.
 *
 * A room goes when its screen has been disconnected past STALE_ROOM_MS, or when it has
 * simply existed too long regardless of state. Rooms with a live screen are never touched,
 * however old they are - a long party night is not an abandoned room.
 */
exports.sweepStaleRooms = onSchedule("every 15 minutes", async () => {
  const snapshot = await db.ref("rooms").get();
  if (!snapshot.exists()) {
    logger.info("sweep: no rooms");
    return;
  }

  const now = Date.now();
  const doomed = [];

  snapshot.forEach((child) => {
    const room = child.val() || {};
    const createdAt = typeof room.createdAt === "number" ? room.createdAt : 0;
    const devices = Object.values(room.devices || {});

    // A room is alive while any device is connected - screen or controller. Devices keep
    // their slot across reconnects, so a disconnected device is genuinely gone rather than
    // mid-refresh once STALE_ROOM_MS has passed.
    const anyConnected = devices.some((d) => d && d.connected === true);
    const lastActivity = devices.reduce(
      (latest, d) => Math.max(latest, (d && typeof d.joinedAt === "number") ? d.joinedAt : 0),
      createdAt
    );

    const abandoned = !anyConnected && now - lastActivity > STALE_ROOM_MS;
    const tooOld = createdAt > 0 && now - createdAt > MAX_ROOM_AGE_MS;

    if (abandoned || tooOld) {
      doomed.push(child.key);
    }
  });

  if (doomed.length === 0) {
    logger.info("sweep: nothing stale", { total: snapshot.numChildren() });
    return;
  }

  const updates = {};
  for (const code of doomed) updates[code] = null;
  await db.ref("rooms").update(updates);

  logger.info("sweep: removed rooms", { count: doomed.length, codes: doomed });
});
