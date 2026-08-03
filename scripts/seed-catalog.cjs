#!/usr/bin/env node
/**
 * Seeds the Firestore game catalog.
 *
 * Clients can only read /games (see firestore.rules), so the catalog is written here with
 * the admin SDK. Re-running is safe: each game is merged, not duplicated.
 *
 *   node scripts/seed-catalog.cjs                 # against the live project
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *     node scripts/seed-catalog.cjs               # against the emulator
 */
const admin = require("firebase-admin");

const PROJECT_ID = process.env.GCLOUD_PROJECT || "webconsole-8a62c";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const GAMES = [
  {
    id: "tapwar",
    name: "Tap War",
    description: "A race to 50 taps. Simplest possible test of the whole pipe.",
    thumbnailUrl: null,
    minPlayers: 1,
    maxPlayers: 8,
    screenUrl: "/games/tapwar/screen.html",
    controllerUrl: "/games/tapwar/controller.html",
  },
  {
    id: "roperaid",
    name: "Rope Raid",
    description:
      "Swing your way to the finish. Hold to fire your grappling hook, let go at the bottom of the arc to launch. Time it right and gravity does the work.",
    thumbnailUrl: null,
    minPlayers: 1,
    maxPlayers: 8,
    screenUrl: "/games/roperaid/screen.html",
    controllerUrl: "/games/roperaid/controller.html",
  },
  {
    id: "chess3d",
    name: "Gambit",
    description:
      "Chess from behind your own pieces. The screen puts you at the board in 3D and swings around to the other side on every turn; your phone is a flat board you actually play on. Take a piece and it shatters where it stood.",
    thumbnailUrl: null,
    // Exactly two play; anyone else joining watches and takes the next open seat.
    minPlayers: 2,
    maxPlayers: 8,
    screenUrl: "/games/chess3d/screen.html",
    controllerUrl: "/games/chess3d/controller.html",
  },
  {
    id: "nidhogg",
    name: "Nidhogg",
    description:
      "A tug-of-war fencing duel. Kills buy you ground, not points: win an exchange and the screen scrolls toward your opponent's edge, lose one and it comes straight back. Everything is a one-hit kill, so it comes down to high, middle, or low.",
    thumbnailUrl: "/games/nidhogg/image.png",
    // Strictly 1v1. Extra phones wait for the next round.
    minPlayers: 2,
    maxPlayers: 2,
    screenUrl: "/games/nidhogg/screen.html",
    controllerUrl: "/games/nidhogg/controller.html",
  },
];

async function main() {
  const batch = db.batch();
  for (const { id, ...game } of GAMES) {
    batch.set(db.collection("games").doc(id), game, { merge: true });
  }
  await batch.commit();
  console.log(
    `seeded ${GAMES.length} game(s) into ${PROJECT_ID}` +
      (process.env.FIRESTORE_EMULATOR_HOST ? " (emulator)" : "") +
      ": " + GAMES.map((g) => g.id).join(", ")
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("seed failed:", err.message);
    // The admin SDK reports expired//revoked Application Default Credentials as a bare
    // "invalid_grant", which says nothing about how to fix it.
    if (/invalid_grant|could not load the default credentials|metadata from plugin/i.test(err.message)) {
      console.error(
        "\nThis is a credentials problem, not a code one. Your Application Default\n" +
          "Credentials are missing or belong to an account that no longer exists.\n\n" +
          "  gcloud auth application-default login\n\n" +
          "(The Firebase CLI login is separate and can look fine while this is broken.)"
      );
    }
    process.exit(1);
  }
);
