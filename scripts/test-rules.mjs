#!/usr/bin/env node
/**
 * Security-rules tests against the RTDB emulator.
 *
 * The model is AirConsole's: devices hold numbered slots (screen = 0), each records the
 * location it's on, and the master controller is DERIVED from that rather than stored.
 * These tests assert the invariants that survive:
 *
 *   1. a device can only write its own slot
 *   2. slot assignments are permanent - nobody can steal or reassign one
 *   3. only devices in the room can navigate it or send messages
 *   4. a message cannot be forged to look like it came from someone else
 *   5. rooms cannot be created, deleted or back-dated by a client
 *
 * Run the emulators first:
 *   firebase emulators:start --only database,auth
 *   node scripts/test-rules.mjs
 */
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { ref, set, get, update, push } from "firebase/database";

const HOST = process.env.DATABASE_EMULATOR_HOST || "127.0.0.1:9000";
const [host, port] = HOST.split(":");

const SCREEN_UID = "screen-uid";
const ALICE = "alice-uid";   // slot 1
const BOB = "bob-uid";       // slot 2
const CAROL = "carol-uid";   // no slot
const ROOM = "AB12";
const OTHER_ROOM = "CD34";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: "webconsole-8a62c",
  database: {
    host,
    port: Number(port),
    rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8"),
  },
});

// Seed a room the way createRoom would, plus two controllers that have already joined.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.database();
  await set(ref(db, `rooms/${ROOM}`), {
    home: "/store",
    createdAt: Date.now(),
    uids: { [SCREEN_UID]: 0, [ALICE]: 1, [BOB]: 2 },
    devices: {
      0: { location: "/store", connected: true, joinedAt: Date.now() - 3000 },
      1: { location: "/store", connected: true, joinedAt: Date.now() - 2000, nickname: "Alice" },
      2: { location: "/store", connected: true, joinedAt: Date.now() - 1000, nickname: "Bob" },
    },
  });
  await set(ref(db, `rooms/${OTHER_ROOM}`), {
    home: "/store",
    createdAt: Date.now(),
    uids: { "someone-else": 0 },
    devices: { 0: { location: "/store", connected: true, joinedAt: Date.now() } },
  });
});

const screenDb = testEnv.authenticatedContext(SCREEN_UID).database();
const aliceDb = testEnv.authenticatedContext(ALICE).database();
const bobDb = testEnv.authenticatedContext(BOB).database();
const carolDb = testEnv.authenticatedContext(CAROL).database();
const anonDb = testEnv.unauthenticatedContext().database();

console.log("\ndevice slots");
await check("a device writes its own slot", () =>
  assertSucceeds(update(ref(aliceDb, `rooms/${ROOM}/devices/1`), { location: "/games/tapwar/" }))
);
await check("a device cannot write another device's slot", () =>
  assertFails(update(ref(aliceDb, `rooms/${ROOM}/devices/2`), { location: "/games/hijack/" }))
);
await check("a device cannot write the screen's slot", () =>
  assertFails(update(ref(aliceDb, `rooms/${ROOM}/devices/0`), { location: "/games/hijack/" }))
);
await check("the screen writes its own slot", () =>
  assertSucceeds(update(ref(screenDb, `rooms/${ROOM}/devices/0`), { location: "/games/tapwar/" }))
);
await check("a device without a slot cannot write one", () =>
  assertFails(update(ref(carolDb, `rooms/${ROOM}/devices/3`), { location: "/store", connected: true }))
);
await check("unauthenticated cannot write a device", () =>
  assertFails(update(ref(anonDb, `rooms/${ROOM}/devices/1`), { connected: true }))
);
await check("a device cannot write unknown fields", () =>
  assertFails(update(ref(aliceDb, `rooms/${ROOM}/devices/1`), { isMaster: true }))
);

// The exact shape attachDevice() writes. The screen passes nickname: null (it has no
// name), which a string-only validator rejected - taking the whole presence update, and
// the onDisconnect attached to it, down with a permission_denied.
console.log("\npresence writes as the client actually makes them");
await check("the screen registers presence with a null nickname", () =>
  assertSucceeds(
    update(ref(screenDb, `rooms/${ROOM}/devices/0`), {
      location: "/store", connected: true, joinedAt: Date.now(), nickname: null,
    })
  )
);
await check("a controller registers presence with a nickname", () =>
  assertSucceeds(
    update(ref(aliceDb, `rooms/${ROOM}/devices/1`), {
      location: "/store", connected: true, joinedAt: Date.now(), nickname: "Alice",
    })
  )
);
await check("an over-long nickname is still rejected", () =>
  assertFails(
    update(ref(aliceDb, `rooms/${ROOM}/devices/1`), { nickname: "x".repeat(25) })
  )
);

console.log("\nactive players (screen-only exception)");
// setActivePlayers is screen-only in AirConsole, so the screen may write playerNumber on
// any device - and nothing else on someone else's slot.
await check("the screen assigns player numbers to controllers", () =>
  assertSucceeds(set(ref(screenDb, `rooms/${ROOM}/devices/1/playerNumber`), 0))
);
await check("a controller cannot assign someone else's player number", () =>
  assertFails(set(ref(bobDb, `rooms/${ROOM}/devices/1/playerNumber`), 5))
);
await check("the screen still cannot rewrite a controller's presence", () =>
  assertFails(update(ref(screenDb, `rooms/${ROOM}/devices/1`), { connected: false }))
);
await check("the screen still cannot rewrite a controller's custom state", () =>
  assertFails(set(ref(screenDb, `rooms/${ROOM}/devices/1/custom`), { forged: true }))
);

console.log("\nslot assignment is permanent");
await check("a new device can claim a free slot", () =>
  assertSucceeds(set(ref(carolDb, `rooms/${ROOM}/uids/${CAROL}`), 3))
);
await check("a device cannot reassign its own slot", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/uids/${ALICE}`), 9))
);
// Releasing is allowed so a device can back out of a slot collision and retry.
await check("a device can release its own slot", () =>
  assertSucceeds(set(ref(carolDb, `rooms/${ROOM}/uids/${CAROL}`), null))
);
await check("a device cannot release someone else's slot", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/uids/${BOB}`), null))
);
await check("re-writing the same slot is idempotent", () =>
  assertSucceeds(set(ref(aliceDb, `rooms/${ROOM}/uids/${ALICE}`), 1))
);
await check("a device cannot reassign someone else's slot", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/uids/${BOB}`), 9))
);
await check("a device cannot claim a slot for another uid", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/uids/somebody-new`), 7))
);

console.log("\nnavigation");
// Any device in the room may navigate, matching AirConsole - navigateTo is callable by
// any device, and the UI decides who is offered it.
await check("a controller can navigate the room", () =>
  assertSucceeds(set(ref(aliceDb, `rooms/${ROOM}/home`), "/games/tapwar/"))
);
await check("the screen can navigate the room", () =>
  assertSucceeds(set(ref(screenDb, `rooms/${ROOM}/home`), "/store"))
);
await check("a device outside the room cannot navigate it", () =>
  assertFails(set(ref(carolDb, `rooms/${OTHER_ROOM}/home`), "/games/hijack/"))
);
await check("navigation rejects a javascript: url", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/home`), "javascript:alert(1)"))
);
await check("navigation rejects a plain http:// url", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/home`), "http://evil.example.com/"))
);
await check("navigation rejects a protocol-relative url", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/home`), "//evil.example.com/"))
);
await check("navigation accepts an https:// url", () =>
  assertSucceeds(set(ref(aliceDb, `rooms/${ROOM}/home`), "https://games.example.com/pong/"))
);

console.log("\nmessaging");
await check("a device sends a message as itself", () =>
  assertSucceeds(
    push(ref(aliceDb, `rooms/${ROOM}/messages`), { from: 1, to: 0, data: { seq: 1 }, at: Date.now() })
  )
);
await check("a device cannot forge another device's id", () =>
  assertFails(
    push(ref(aliceDb, `rooms/${ROOM}/messages`), { from: 2, to: 0, data: { seq: 1 }, at: Date.now() })
  )
);
await check("a device outside the room cannot send", () =>
  assertFails(
    push(ref(carolDb, `rooms/${OTHER_ROOM}/messages`), { from: 0, to: null, data: {}, at: Date.now() })
  )
);
await check("a broadcast (to: null) is allowed", () =>
  assertSucceeds(
    push(ref(screenDb, `rooms/${ROOM}/messages`), { from: 0, to: null, data: { phase: "play" }, at: Date.now() })
  )
);
// Messages are transient and trimmed by the sender, so deleting must work - but editing
// a delivered message must not.
await check("a device in the room can delete an old message", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), `rooms/${ROOM}/messages/old1`), {
      from: 0, to: null, data: { x: 1 }, at: Date.now(),
    });
  });
  return assertSucceeds(set(ref(aliceDb, `rooms/${ROOM}/messages/old1`), null));
});
await check("nobody can edit a delivered message", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), `rooms/${ROOM}/messages/old2`), {
      from: 0, to: null, data: { x: 1 }, at: Date.now(),
    });
  });
  return assertFails(
    set(ref(aliceDb, `rooms/${ROOM}/messages/old2`), { from: 1, to: null, data: { x: 2 }, at: Date.now() })
  );
});

console.log("\nroom integrity");
await check("cannot create a room client-side", () =>
  assertFails(set(ref(aliceDb, "rooms/ZZ99"), { home: "/store", createdAt: Date.now() }))
);
await check("cannot delete a room", () => assertFails(set(ref(aliceDb, `rooms/${ROOM}`), null)));
await check("cannot change createdAt", () =>
  assertFails(set(ref(aliceDb, `rooms/${ROOM}/createdAt`), 1))
);
await check("cannot write a malformed room code", () =>
  assertFails(set(ref(aliceDb, `rooms/not-a-code/home`), "/store"))
);
await check("cannot join a nonexistent room", () =>
  assertFails(set(ref(aliceDb, `rooms/QQ88/uids/${ALICE}`), 1))
);

console.log("\nreads");
await check("an authenticated device can read the room", () =>
  assertSucceeds(get(ref(aliceDb, `rooms/${ROOM}`)))
);
await check("unauthenticated cannot read the room", () =>
  assertFails(get(ref(anonDb, `rooms/${ROOM}`)))
);

await testEnv.cleanup();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
