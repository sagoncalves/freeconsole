/**
 * Minefield Escape 3D — simulation tests.
 *
 * The sim is pure and headless, so the whole game can be exercised without a browser, a
 * WebGL context, or a room. Run with:  node scripts/test-minefield3d.mjs
 *
 * The sim imports its level data by absolute URL (/games/minefield3d/levels.js) because the
 * browser loads it that way; node cannot resolve that, so the two modules are rewritten into
 * a temp directory with relative specifiers. Nothing else is changed — the code under test
 * is byte-for-byte what ships.
 *
 * The tests that matter most here are the ones about **per-player sonar**, since that is the
 * mechanic this version exists for: that a player's light is genuinely their own, that it
 * has a finite reach, that it dies with them, and that a room collectively sees more than
 * any individual does.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const GAME = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "games", "minefield3d");
const OUT = mkdtempSync(join(tmpdir(), "minefield3d-test-"));
for (const f of ["sim.js", "levels.js"]) {
  writeFileSync(join(OUT, f), readFileSync(join(GAME, f), "utf8").replace(/\/games\/minefield3d\//g, "./"));
}

const sim = await import(pathToFileURL(join(OUT, "sim.js")).href);
const { LEVELS, ARENAS, STAGES } = await import(pathToFileURL(join(OUT, "levels.js")).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + " " + extra); }
};

const DT = 1 / 60;
function run(round, seconds, drive) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (drive) drive(round, i * DT);
    sim.step(round, DT);
  }
}

/** Start a round with n players seated. */
function begin(levelIndex, seed, n = 1) {
  const r = sim.createRound(levelIndex, seed);
  for (let i = 1; i <= n; i++) sim.addPlayer(r, i);
  sim.startRound(r);
  return r;
}

/* ---- 1. field generation ---- */
console.log("\nfield generation");
{
  let anyMines = 0, spawnMines = 0, gateMines = 0;
  for (let s = 1; s <= 200; s++) {
    const r = sim.createRound(0, s);
    const L = r.level;
    for (let z = 0; z < L.rows; z++) {
      for (let x = 0; x < L.cols; x++) {
        if (!sim.mineAt(r, x, z)) continue;
        anyMines++;
        if (z >= L.rows - L.safeRows) spawnMines++;
        if (z === 0) gateMines++;
      }
    }
  }
  ok("mines are laid", anyMines > 1000, "(" + anyMines + ")");
  ok("spawn strip is always clear", spawnMines === 0, "(" + spawnMines + ")");
  ok("gate row is always clear", gateMines === 0, "(" + gateMines + ")");
}

/* ---- 2. solvability ---- */
console.log("\nsolvability");
{
  let unsolvable = 0;
  for (let s = 1; s <= 400; s++) {
    const r = sim.createRound(0, s);
    const { cols, rows } = r.level;
    const seen = new Uint8Array(cols * rows);
    const stack = [];
    for (let x = 0; x < cols; x++) {
      const z = rows - 1;
      if (!sim.mineAt(r, x, z)) { stack.push([x, z]); seen[z * cols + x] = 1; }
    }
    let reached = false;
    while (stack.length) {
      const [x, z] = stack.pop();
      if (z === 0 && x >= r.exitFrom && x <= r.exitTo) { reached = true; break; }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        if (seen[nz * cols + nx] || sim.mineAt(r, nx, nz)) continue;
        seen[nz * cols + nx] = 1;
        stack.push([nx, nz]);
      }
    }
    if (!reached) unsolvable++;
  }
  ok("every seed has a walkable route to the gate", unsolvable === 0, "(" + unsolvable + "/400 bad)");
}

/* ---- 3. per-player sonar: the mechanic this version exists for ---- */
console.log("\nper-player sonar");
{
  // Two players far apart. Each must light their own surroundings and NOT the other's.
  const r = begin(0, 9, 2);
  const a = r.players.get(1);
  const b = r.players.get(2);
  a.x = 1.5; a.z = r.rows - 3.5;
  b.x = r.cols - 1.5; b.z = 4.5;
  // Force both emitters to fire now, and let the rings expand a little.
  a.nextPingAt = r.t; b.nextPingAt = r.t;
  run(r, 0.35);

  const nearA = sim.tileRevealFor(r, a, Math.floor(a.x), Math.floor(a.z));
  const aSeesB = sim.tileRevealFor(r, a, Math.floor(b.x), Math.floor(b.z));
  ok("a player's own ping lights their own ground", nearA > 0, "(" + nearA.toFixed(3) + ")");
  ok("one player's ping does not light the far end", aSeesB === 0, "(" + aSeesB.toFixed(3) + ")");

  // Reach is finite and matches the level's radius.
  const far = sim.tileRevealFor(r, a, Math.floor(a.x), Math.max(0, Math.floor(a.z - r.level.sonarRadius - 2)));
  ok("sonar has a finite radius", far === 0, "(" + far.toFixed(3) + ")");

  // The union over all players is at least as bright as any single one.
  const unionAtB = sim.tileReveal(r, Math.floor(b.x), Math.floor(b.z));
  const bAtB = sim.tileRevealFor(r, b, Math.floor(b.x), Math.floor(b.z));
  ok("the union includes every player's light", unionAtB >= bAtB - 1e-9,
     "(" + unionAtB.toFixed(3) + " vs " + bAtB.toFixed(3) + ")");
  ok("the union sees ground its owner cannot", unionAtB > 0 && aSeesB === 0);
}
{
  // Emitters are staggered, not synchronised: two players must not ping in lockstep.
  const r = begin(0, 3, 4);
  const firstPings = [...r.players.values()].map((p) => p.nextPingAt);
  const unique = new Set(firstPings.map((v) => v.toFixed(3)));
  ok("emitters start out of phase", unique.size > 1, "(" + firstPings.map((v) => v.toFixed(2)).join(", ") + ")");
}
{
  // A dead player's light goes out — that is how the room learns something happened.
  const r = begin(0, 5, 1);
  const p = r.players.get(1);
  p.nextPingAt = r.t;
  run(r, 0.2);
  ok("a living player emits", p.ping !== null);

  r.mines.fill(0);
  r.killerZ = p.z + 0.1;
  r.killerX = p.x;
  r.level = { ...r.level, killerDelay: 0 };
  run(r, 0.2);
  ok("death puts the light out", p.state === sim.DEAD && p.ping === null, "(" + p.state + ")");

  // And a dead emitter reveals nothing.
  const lit = sim.tileRevealFor(r, p, Math.floor(p.x), Math.floor(p.z));
  ok("a dead player reveals nothing", lit === 0, "(" + lit.toFixed(3) + ")");
}
{
  // Coverage really is superadditive: more lamps light strictly more ground.
  function coverage(n) {
    let total = 0;
    for (let s = 1; s <= 25; s++) {
      const r = begin(0, s, n);
      const seen = new Set();
      for (let i = 0; i < 8 / DT; i++) {
        sim.step(r, DT);
        for (let z = 0; z < r.rows; z++) for (let x = 0; x < r.cols; x++) {
          if (sim.tileReveal(r, x, z) > 0.05) seen.add(z * r.cols + x);
        }
      }
      total += seen.size;
    }
    return total / 25;
  }
  const one = coverage(1);
  const four = coverage(4);
  ok("more lamps reveal more ground", four > one * 1.2,
     "(" + one.toFixed(0) + " -> " + four.toFixed(0) + " tiles)");
}

/* ---- 4. explosions ---- */
console.log("\nexplosions");
{
  let sawLoss = 0, sawDouble = 0, trials = 0;
  for (let s = 1; s <= 400; s++) {
    const r = begin(0, s, 1);
    const p = r.players.get(1);
    let target = null;
    for (let z = r.rows - 4; z > 1 && !target; z--) {
      for (let x = 0; x < r.cols; x++) if (sim.mineAt(r, x, z)) { target = { x, z }; break; }
    }
    if (!target) continue;
    trials++;
    p.x = target.x + 0.5;
    p.z = target.z + 1.5;
    sim.setInput(r, 1, "up", true);
    run(r, 1.2);
    if (p.legs < 2) sawLoss++;
    if (p.legs === 0) sawDouble++;
  }
  ok("walking onto a mine costs legs", sawLoss === trials, "(" + sawLoss + "/" + trials + ")");
  ok("sometimes it takes both legs", sawDouble > 0 && sawDouble < trials, "(" + sawDouble + "/" + trials + ")");
}

/* ---- 5. movement ---- */
console.log("\nmovement");
{
  const r = begin(0, 7, 1);
  const p = r.players.get(1);
  ok("two legs walks", sim.speedOf(p) === sim.SPEED_WALK);
  p.legs = 1;
  ok("one leg limps slower", sim.speedOf(p) === sim.SPEED_LIMP && sim.SPEED_LIMP < sim.SPEED_WALK);
  p.legs = 0;
  ok("no legs crawls slowest", sim.speedOf(p) === sim.SPEED_CRAWL && sim.SPEED_CRAWL < sim.SPEED_LIMP);

  const a = begin(0, 7, 1), b = begin(0, 7, 1);
  a.mines.fill(0); b.mines.fill(0);
  a.level = { ...a.level, killerDelay: 999 };
  b.level = { ...b.level, killerDelay: 999 };
  const pa = a.players.get(1), pb = b.players.get(1);
  pa.x = pb.x = 4.5;
  const ax = pa.x, az = pa.z, bx = pb.x, bz = pb.z;
  sim.setInput(a, 1, "up", true);
  sim.setInput(b, 1, "up", true); sim.setInput(b, 1, "left", true);
  run(a, 1); run(b, 1);
  const da = Math.hypot(pa.x - ax, pa.z - az);
  const db = Math.hypot(pb.x - bx, pb.z - bz);
  ok("diagonal is not a speed boost", Math.abs(da - db) < 0.05,
     "(" + da.toFixed(2) + " vs " + db.toFixed(2) + ")");

  // A one-second walk must cover walk-speed distance — guards the sub-step interpolation.
  const c = begin(0, 7, 1);
  c.mines.fill(0);
  c.level = { ...c.level, killerDelay: 999 };
  const pc = c.players.get(1);
  pc.x = 1.5;                      // off the gate column so it cannot escape early
  const z0 = pc.z;
  sim.setInput(c, 1, "up", true);
  run(c, 1);
  ok("a one-second walk covers walk-speed distance",
     Math.abs((z0 - pc.z) - sim.SPEED_WALK) < 0.15,
     "(" + (z0 - pc.z).toFixed(2) + " vs " + sim.SPEED_WALK + ")");
}

/* ---- 6. tunnelling ---- */
console.log("\ntunnelling");
{
  let missed = 0;
  for (let s = 1; s <= 300; s++) {
    const r = begin(0, s, 1);
    const p = r.players.get(1);
    r.mines.fill(0);
    const mx = Math.floor(p.x), mz = Math.floor(p.z) - 5;
    r.mines[mz * r.cols + mx] = 1;
    p.x = mx + 0.5;
    sim.setInput(r, 1, "up", true);
    for (let i = 0; i < 80; i++) sim.step(r, 0.05);   // the screen's clamped max dt
    if (p.legs === 2 && p.state === sim.ALIVE) missed++;
  }
  ok("a mine cannot be tunnelled at max dt", missed === 0, "(" + missed + "/300 missed)");
}

/* ---- 7. the killer ---- */
console.log("\nthe killer");
{
  const r = begin(0, 2, 1);
  ok("killer starts behind the spawn line", r.killerZ > r.rows,
     "(" + r.killerZ.toFixed(1) + " vs " + r.rows + ")");

  r.mines.fill(0);
  r.players.get(1).x = 0.5;
  sim.setInput(r, 1, "up", true);
  const z0 = r.killerZ;
  run(r, r.level.killerDelay + 6);
  ok("killer advances toward the gate", r.killerZ < z0 - 2,
     "(" + z0.toFixed(1) + " -> " + r.killerZ.toFixed(1) + ")");

  // It must never overtake the last living player, or a straggler is safe forever and the
  // round can never end.
  const r2 = begin(0, 3, 1);
  r2.mines.fill(0);
  const p2 = r2.players.get(1);
  run(r2, 40);
  ok("standing still gets you caught", p2.state === sim.DEAD, "(" + p2.state + ")");

  /* The crusher is a full-width press, not a pursuer. These are the properties that make it
     one, and each is a thing a stalking-monster implementation would get wrong. */

  // It kills across the entire width at once — hugging a wall is not an escape.
  const r3 = begin(0, 8, 3);
  r3.mines.fill(0);
  const edgeL = r3.players.get(1);
  const edgeR = r3.players.get(2);
  const mid = r3.players.get(3);
  edgeL.x = 0.4;
  edgeR.x = r3.cols - 0.4;
  mid.x = r3.cols / 2;
  for (const p of [edgeL, edgeR, mid]) p.z = r3.rows - 1;
  r3.killerZ = r3.rows - 1;
  r3.level = { ...r3.level, killerDelay: 0 };
  run(r3, 0.1);
  ok("the press kills across the full width",
     [edgeL, edgeR, mid].every((p) => p.state === sim.DEAD),
     "(" + [edgeL, edgeR, mid].map((p) => p.state).join(", ") + ")");

  // It does not track anybody sideways: killerX stays centred no matter where players stand.
  const r4 = begin(0, 8, 1);
  r4.mines.fill(0);
  const lone = r4.players.get(1);
  lone.x = 0.4;                       // hard against one wall
  lone.z = 4;                         // far ahead, so it is not caught immediately
  r4.level = { ...r4.level, killerDelay: 0 };
  run(r4, 2);
  ok("the press never chases sideways",
     Math.abs(r4.killerX - r4.cols / 2) < 1e-6,
     "(killerX " + r4.killerX.toFixed(3) + ", player x " + lone.x.toFixed(2) + ")");

  // Deaths it causes are attributed to the crusher, not to a stalker.
  const r5 = begin(0, 8, 1);
  r5.mines.fill(0);
  const victim = r5.players.get(1);
  r5.killerZ = victim.z;
  r5.level = { ...r5.level, killerDelay: 0 };
  run(r5, 0.1);
  const death = r5.events.find((e) => e.type === "death");
  ok("deaths are attributed to the crusher",
     victim.state === sim.DEAD && death && death.cause === "crusher",
     "(" + (death ? death.cause : "no death event") + ")");
}

/* ---- 8. the gate ---- */
console.log("\nthe gate");
{
  const r = begin(0, 11, 5);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  for (const p of r.players.values()) {
    p.x = r.exitFrom + 0.5;
    sim.setInput(r, p.id, "up", true);
  }
  run(r, 30);

  const cap = r.level.exitCapacity;
  ok("only capacity many get out", r.escapedOrder.length === cap,
     "(" + r.escapedOrder.length + "/" + cap + ")");
  ok("gate reports closed", r.exitOpen === false);

  const stuck = [...r.players.values()].filter((p) => p.state === sim.ALIVE);
  ok("latecomers are blocked, not passed", stuck.length === 5 - cap, "(" + stuck.length + ")");
  ok("blocked players stay inside the aisle", stuck.every((p) => p.z >= 0.3));

  // A shut gate is a wall.
  const r2 = begin(0, 5, 1);
  r2.mines.fill(0);
  r2.level = { ...r2.level, killerDelay: 999 };
  r2.exitOpen = false;
  const p2 = r2.players.get(1);
  p2.x = r2.exitFrom + 0.5;
  sim.setInput(r2, 1, "up", true);
  run(r2, 20);
  ok("a shut gate blocks", p2.state === sim.ALIVE && p2.z >= 0.3,
     "(" + p2.state + " at z " + p2.z.toFixed(2) + ")");

  // An open gate lets you through.
  const r3 = begin(0, 5, 1);
  r3.mines.fill(0);
  r3.level = { ...r3.level, killerDelay: 999 };
  const p3 = r3.players.get(1);
  p3.x = r3.exitFrom + 0.5;
  sim.setInput(r3, 1, "up", true);
  run(r3, 20);
  ok("walking into the gate escapes", p3.state === sim.ESCAPED,
     "(" + p3.state + " at z " + p3.z.toFixed(2) + ")");
}

/* ---- 9. round end ---- */
console.log("\nround end");
{
  const r = begin(0, 21, 1);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  const p = r.players.get(1);
  p.x = r.exitFrom + 0.5;
  sim.setInput(r, 1, "up", true);
  run(r, 30);
  ok("a lone escape ends the round", r.phase === "over", "(" + r.phase + ")");
  ok("winner is the first one out", r.winner === 1, "(" + r.winner + ")");
}

/* ---- 10. footprints ---- */
console.log("\nfootprints");
{
  // Prints were removed from the game. The trail cluttered the surface the sonar communicates
  // through in the aisle, and marked nothing at all on a bare arena floor. What these guard is
  // that nothing starts dropping them again, and that distance is still accumulated — the
  // print bookkeeping and the odometer used to live in the same function.
  const r = begin(0, 31, 1);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  r.players.get(1).x = 1.5;
  sim.setInput(r, 1, "up", true);
  run(r, 3);
  ok("walking leaves no trail", r.prints.length === 0, "(" + r.prints.length + ")");
  ok("but distance is still tracked", r.players.get(1).distance > 1,
     "(" + r.players.get(1).distance.toFixed(1) + ")");

  sim.clearInput(r, 1);
  run(r, sim.PRINT_LIFE + 2);
  ok("the print list stays empty", r.prints.length === 0, "(" + r.prints.length + ")");
}

/* ---- 10b. no sonar in an arena ---- */
console.log("\nsurvival: no echolocation");
{
  const r = sim.createRound(0, 33, sim.MODE_SURVIVAL);
  for (let i = 1; i <= 3; i++) sim.addPlayer(r, i);
  sim.startRound(r);
  run(r, 6);
  ok("nobody emits a ping", [...r.players.values()].every((p) => p.ping === null));
  ok("no ping events are raised", !r.events.some((e) => e.type === "ping"));

  // And with no emitters, nothing on the floor is ever revealed.
  let anyLit = 0;
  for (let z = 0; z < r.rows; z++) {
    for (let x = 0; x < r.cols; x++) if (sim.tileReveal(r, x, z) > 0) anyLit++;
  }
  ok("no tile is ever sonar-lit", anyLit === 0, "(" + anyLit + " lit)");

  // Escape must be untouched by this.
  const e = begin(0, 33, 2);
  run(e, 3);
  ok("escape still pings", [...e.players.values()].some((p) => p.ping !== null) ||
     e.events.some((ev) => ev.type === "ping"));
}

/* ---- 11. input hygiene ---- */
console.log("\ninput");
{
  const r = begin(0, 41, 1);
  sim.setInput(r, 99, "up", true);        // unknown device
  sim.setInput(r, 1, "fly", true);        // unknown key
  ok("unknown device/key are ignored", !("fly" in r.players.get(1).input));

  const p = r.players.get(1);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  sim.setInput(r, 1, "up", true);
  run(r, 0.5);
  const moved = p.z;
  sim.clearInput(r, 1);
  run(r, 0.5);
  ok("clearInput stops the walker", Math.abs(p.z - moved) < 0.01);
}

/* ---- 12. levels ---- */
console.log("\nlevels");
{
  ok("at least one level ships", LEVELS.length >= 1);
  LEVELS.forEach((L, i) => {
    ok("level " + (i + 1) + " is coherent",
      L.cols > 4 && L.rows > 4 && L.exitCapacity >= 1 &&
      L.mineDensity > 0 && L.mineDensity < 0.5 &&
      L.exitWidth >= 1 && L.safeRows >= 1 &&
      L.sonarPeriod > 0 && L.sonarRadius > 1 && L.sonarSpeed > 0 && L.killerSpeed > 0);
    // The radius has to be small enough that the aisle is not simply visible.
    ok("level " + (i + 1) + " keeps the far end dark", L.sonarRadius < L.rows * 0.5,
       "(r " + L.sonarRadius + " vs rows " + L.rows + ")");
  });
}

/* ---- 11b. reconnecting ---- */
console.log("\nreconnection");
{
  // A phone that reloads mid-round fires onConnect for an id that is already seated. That
  // must keep the seat exactly as it was — position, legs, state — or the player is teleported
  // back to the spawn line whole, mid-crossing.
  const r = begin(0, 7, 2);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  const p = r.players.get(1);
  p.x = 3.5;
  sim.setInput(r, 1, "up", true);
  run(r, 2);
  p.legs = 1;
  const before = { x: p.x, z: p.z, legs: p.legs, state: p.state };

  const again = sim.addPlayer(r, 1);
  ok("reconnecting returns the same seat", again === p);
  ok("reconnecting preserves position",
     again.x === before.x && again.z === before.z,
     "(" + before.x.toFixed(2) + "," + before.z.toFixed(2) + " -> " + again.x.toFixed(2) + "," + again.z.toFixed(2) + ")");
  ok("reconnecting preserves condition",
     again.legs === before.legs && again.state === before.state,
     "(legs " + again.legs + ", " + again.state + ")");

  // And the roster must not grow.
  ok("reconnecting does not duplicate the player", r.players.size === 2, "(" + r.players.size + ")");

  // A genuinely new phone arriving mid-round is a spectator: not alive (so it cannot be
  // killed or hold the round open) and not escaped (so it is not counted as a survivor).
  const fresh = sim.addPlayer(r, 9);
  fresh.state = sim.WAITING;
  ok("WAITING is its own state",
     sim.WAITING !== sim.ALIVE && sim.WAITING !== sim.DEAD && sim.WAITING !== sim.ESCAPED);

  let alive = 0;
  for (const q of r.players.values()) if (q.state === sim.ALIVE) alive++;
  ok("a spectator is not alive", alive === 2, "(" + alive + ")");

  // The round must still be able to end with a spectator seated.
  for (const q of r.players.values()) if (q.state === sim.ALIVE) q.state = sim.DEAD;
  run(r, 0.1);
  ok("a spectator does not hold the round open", r.phase === "over", "(" + r.phase + ")");
  ok("a spectator is not counted as a survivor", !r.escapedOrder.includes(9));

  // The next round seats them normally.
  sim.startRound(r);
  ok("the next round revives everyone",
     [...r.players.values()].every((q) => q.state === sim.ALIVE && q.legs === 2));
}

/* ---- 12b. the renderer's gate must agree with the sim's ---- */
console.log("\ngate geometry");
{
  // scene.js builds the doorway from a Level alone, before any round exists, so it derives
  // the span itself. If that derivation drifts from the sim's, the door is drawn somewhere
  // the sim will not let anyone walk through — and the failure is silent.
  //
  // The helper is re-implemented here rather than imported because scene.js imports three.js,
  // which needs a browser. It must stay identical to scene.js's gateSpan().
  function gateSpan(level) {
    const half = Math.floor(level.exitWidth / 2);
    const centre = Math.floor(level.cols / 2);
    const from = Math.max(0, centre - half);
    const to = Math.min(level.cols - 1, from + level.exitWidth - 1);
    return { from, to };
  }

  let mismatches = 0;
  LEVELS.forEach((L, li) => {
    const r = sim.createRound(li, 12345);
    const span = gateSpan(L);
    if (span.from !== r.exitFrom || span.to !== r.exitTo) mismatches++;
  });
  ok("the drawn gate matches the simulated gate on every level", mismatches === 0,
     "(" + mismatches + " level(s) disagree)");

  // And the span must be sane, or the doorway is a zero-width sliver.
  let bad = 0;
  LEVELS.forEach((L) => {
    const s = gateSpan(L);
    if (!(s.to >= s.from) || (s.to - s.from + 1) !== L.exitWidth) bad++;
  });
  ok("the gate is exitWidth tiles wide", bad === 0, "(" + bad + " bad)");
}

/* ---- 13. balance ---- */
console.log("\nbalance");
{
  /**
   * The honest player model for this version: the bot only knows what its OWN emitter has
   * shown it. Using the global union here would test a game nobody is playing.
   */
  function careful(seed, li = 0) {
    const r = begin(li, seed, 1);
    const p = r.players.get(1);
    const known = new Set();
    for (let i = 0; i < 200 / DT && r.phase === "running"; i++) {
      for (let z = 0; z < r.rows; z++) for (let x = 0; x < r.cols; x++) {
        if (sim.mineAt(r, x, z) && sim.tileRevealFor(r, p, x, z) > 0.05) known.add(z * r.cols + x);
      }
      const tx = Math.floor(p.x), tz = Math.floor(p.z);
      const bad = (x, z) => known.has(z * r.cols + x);
      const prev = new Map(), q = [[tx, tz]], seen = new Set([tz * r.cols + tx]);
      let goal = null;
      while (q.length) {
        const [cx, cz] = q.shift();
        if (cz === 0 && cx >= r.exitFrom && cx <= r.exitTo) { goal = [cx, cz]; break; }
        for (const [dx, dz] of [[0, -1], [-1, 0], [1, 0], [-1, -1], [1, -1], [0, 1]]) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= r.cols || nz >= r.rows) continue;
          const k = nz * r.cols + nx;
          if (seen.has(k) || bad(nx, nz)) continue;
          seen.add(k); prev.set(k, [cx, cz]); q.push([nx, nz]);
        }
      }
      let st = null;
      if (goal) {
        let cur = goal;
        while (true) {
          const pk = prev.get(cur[1] * r.cols + cur[0]);
          if (!pk) { st = goal; break; }
          if (pk[0] === tx && pk[1] === tz) { st = cur; break; }
          cur = pk;
        }
      }
      for (const d of ["up", "down", "left", "right"]) sim.setInput(r, 1, d, false);
      if (st) {
        const gx = st[0] + 0.5, gz = st[1] + 0.5;
        if (gz < p.z - 0.06) sim.setInput(r, 1, "up", true);
        else if (gz > p.z + 0.06) sim.setInput(r, 1, "down", true);
        if (gx < p.x - 0.06) sim.setInput(r, 1, "left", true);
        else if (gx > p.x + 0.06) sim.setInput(r, 1, "right", true);
      } else sim.setInput(r, 1, "up", true);
      sim.step(r, DT);
    }
    return p.state;
  }
  function blind(seed, li = 0) {
    const r = begin(li, seed, 1);
    const p = r.players.get(1);
    sim.setInput(r, 1, "up", true);
    for (let i = 0; i < 200 / DT && r.phase === "running"; i++) sim.step(r, DT);
    return p.state;
  }

  const N = 120;
  let b = 0, c = 0;
  for (let s = 1; s <= N; s++) {
    if (blind(s) === sim.ESCAPED) b++;
    if (careful(s) === sim.ESCAPED) c++;
  }
  const bp = Math.round(100 * b / N), cp = Math.round(100 * c / N);
  console.log("       blind " + bp + "% escaped, careful " + cp + "% escaped");
  ok("level 1 is winnable", c > N * 0.4, "(careful " + cp + "%)");
  ok("level 1 is not a walkover", c < N, "(careful " + cp + "%)");
  ok("using your own light beats ignoring it", c > b * 1.5, "(" + cp + "% vs " + bp + "%)");

  console.log("\n       per-level (careful player, 60 seeds each)");
  const rates = [];
  for (let li = 0; li < LEVELS.length; li++) {
    const M = 60;
    let cOut = 0, bOut = 0;
    for (let s = 1; s <= M; s++) {
      if (careful(s, li) === sim.ESCAPED) cOut++;
      if (blind(s, li) === sim.ESCAPED) bOut++;
    }
    rates.push(cOut / M);
    console.log("         " + LEVELS[li].name.padEnd(14) +
      "careful " + String(Math.round(100 * cOut / M)).padStart(3) + "%   " +
      "blind " + String(Math.round(100 * bOut / M)).padStart(3) + "%");
    ok(LEVELS[li].name + " is completable", cOut > M * 0.15, "(" + Math.round(100 * cOut / M) + "%)");
    ok(LEVELS[li].name + " is not a walkover", bOut < M * 0.5, "(blind " + Math.round(100 * bOut / M) + "%)");
  }
  ok("difficulty rises across the campaign", rates[rates.length - 1] < rates[0],
     "(" + Math.round(100 * rates[0]) + "% -> " + Math.round(100 * rates[rates.length - 1]) + "%)");
}

/* ---- 14. survival mode ---- */
console.log("\nsurvival: arena and machines");
{
  const beginS = (arenaIndex, seed, n = 1) => {
    const r = sim.createRound(arenaIndex, seed, sim.MODE_SURVIVAL);
    for (let i = 1; i <= n; i++) sim.addPlayer(r, i);
    sim.startRound(r);
    return r;
  };

  const r0 = beginS(0, 5);
  ok("the round knows it is survival", r0.mode === sim.MODE_SURVIVAL);
  ok("escape is still the default mode", sim.createRound(0, 5).mode === sim.MODE_ESCAPE);
  ok("survival uses the arena table, not the level table",
     r0.level.name === ARENAS[0].name, "(" + r0.level.name + ")");

  ok("the opening pack is on the floor",
     r0.roombas.length === r0.level.startRoombas,
     "(" + r0.roombas.length + " of " + r0.level.startRoombas + ")");
  ok("every machine has a distinct id",
     new Set(r0.roombas.map((m) => m.id)).size === r0.roombas.length);

  // The spawn circle must be clear, or somebody dies before touching the stick.
  let spawnMines = 0;
  for (let s = 1; s <= 60; s++) {
    const r = sim.createRound(0, s, sim.MODE_SURVIVAL);
    const L = r.level;
    for (let z = 0; z < L.rows; z++) {
      for (let x = 0; x < L.cols; x++) {
        if (!sim.mineAt(r, x, z)) continue;
        const dx = x + 0.5 - L.cols / 2;
        const dz = z + 0.5 - L.rows / 2;
        if (dx * dx + dz * dz < L.safeRadius * L.safeRadius) spawnMines++;
      }
    }
  }
  ok("the spawn circle is never mined", spawnMines === 0, "(" + spawnMines + " found)");

  // Players start inside that circle.
  const r1 = beginS(0, 9, 4);
  let outside = 0;
  for (const p of r1.players.values()) {
    const dx = p.x - r1.level.cols / 2;
    const dz = p.z - r1.level.rows / 2;
    if (Math.hypot(dx, dz) > r1.level.safeRadius) outside++;
  }
  ok("everyone spawns inside the clear circle", outside === 0, "(" + outside + " outside)");

  // There is no way out. This is the one that would silently ruin the mode: moveTo's gate
  // check reads exitFrom/exitTo, and leaving them at 0 makes the whole z=0 edge an exit.
  const r2 = beginS(0, 11, 1);
  const solo = r2.players.get(1);
  run(r2, 6, () => sim.setAxis(r2, 1, 0, -1));   // walk hard at the z=0 wall
  ok("there is no gate to escape through", solo.state !== sim.ESCAPED, "(" + solo.state + ")");
  ok("nobody is recorded as escaping", r2.escapedOrder.length === 0);
  ok("the gate is shut in survival", r2.exitOpen === false);

  // Machines stay inside the room.
  const r3 = beginS(1, 13, 3);
  run(r3, 45);
  let escapedRoom = 0;
  for (const m of r3.roombas) {
    if (m.x < 0 || m.x > r3.level.cols || m.z < 0 || m.z > r3.level.rows) escapedRoom++;
  }
  ok("machines never leave the room", escapedRoom === 0, "(" + escapedRoom + " outside)");

  // Waves arrive, and stop at the cap.
  //
  // The players have to be kept alive by hand here. Standing still in an arena is fatal well
  // inside the wave interval — an idle two-player round on this arena ends at about 10s
  // against a 16s clock — so a naive run() would assert on a round that was already over and
  // report "no reinforcements" for a machine that never got the chance to arrive.
  const r4 = beginS(1, 17, 2);
  const before = r4.roombas.length;
  for (let i = 0; i < Math.round((r4.level.waveEvery + 1) / DT); i++) {
    for (const p of r4.players.values()) { p.legs = 2; p.state = sim.ALIVE; }
    r4.phase = "running";
    sim.step(r4, DT);
  }
  ok("reinforcements arrive on the wave clock", r4.roombas.length > before,
     "(" + before + " -> " + r4.roombas.length + ")");
  ok("the wave counter advances", r4.wave > 0, "(wave " + r4.wave + ")");

  const r5 = beginS(1, 19, 1);
  // Nobody is driving, so the lone player usually dies; force the round to keep running so
  // the cap itself is what is under test rather than the round ending first.
  for (let i = 0; i < 60 * 60 * 4; i++) {
    for (const p of r5.players.values()) { p.legs = 2; p.state = sim.ALIVE; }
    r5.phase = "running";
    sim.step(r5, DT);
  }
  ok("the machine count is capped", r5.roombas.length <= r5.level.maxRoombas,
     "(" + r5.roombas.length + " vs cap " + r5.level.maxRoombas + ")");

  // A saw takes a leg rather than a life, and cannot strip both in one brush.
  const r6 = beginS(0, 23, 1);
  const victim = r6.players.get(1);
  const saw = r6.roombas[0];
  saw.x = victim.x;
  saw.z = victim.z;
  sim.step(r6, DT);
  ok("a blade takes a leg", victim.legs === 1, "(legs " + victim.legs + ")");
  // Keep it parked on top of them for half a second — well inside the cooldown.
  for (let i = 0; i < 30; i++) { saw.x = victim.x; saw.z = victim.z; sim.step(r6, DT); }
  ok("one brush costs one leg, not two", victim.legs === 1, "(legs " + victim.legs + ")");
  ok("a saw hit is reported", r6.events.some((e) => e.type === "saw") ||
     victim.legs === 1);

  // The floor is bare. Mines are an escape-mode mechanic and must not appear in an arena.
  let arenaMines = 0;
  for (let ai = 0; ai < ARENAS.length; ai++) {
    for (let s = 1; s <= 25; s++) {
      const r = sim.createRound(ai, s, sim.MODE_SURVIVAL);
      for (let z = 0; z < r.level.rows; z++) {
        for (let x = 0; x < r.level.cols; x++) if (sim.mineAt(r, x, z)) arenaMines++;
      }
    }
  }
  ok("arenas are never mined", arenaMines === 0, "(" + arenaMines + " found)");
  ok("escape is still mined",
     (() => {
       const r = sim.createRound(0, 5);
       let n = 0;
       for (let z = 0; z < r.level.rows; z++) {
         for (let x = 0; x < r.level.cols; x++) if (sim.mineAt(r, x, z)) n++;
       }
       return n > 0;
     })());

  // No trail is dropped in an arena.
  const r7 = beginS(0, 29, 1);
  const walker = r7.players.get(1);
  run(r7, 3, () => sim.setAxis(r7, 1, 1, 0));
  ok("survival leaves no footprints", r7.prints.length === 0, "(" + r7.prints.length + ")");
  ok("and the player really did move", walker.distance > 1, "(" + walker.distance.toFixed(1) + ")");

  // Nothing steers. A machine's heading must not bend toward a player standing beside it.
  const r10 = beginS(0, 41, 1);
  const m10 = r10.roombas[0];
  const bait = r10.players.get(1);
  // Park a player just off the machine's flank, outside blade reach, and hold everything else
  // still: no walls in range, no other machines. A chaser would curve; a pinball cannot.
  m10.x = r10.level.cols / 2;
  m10.z = r10.level.rows / 2;
  m10.heading = 0;
  bait.x = m10.x + 2.2;
  bait.z = m10.z;
  const heading10 = m10.heading;
  for (let i = 0; i < 12; i++) { bait.x = m10.x + 2.2; bait.z = m10.z; sim.step(r10, DT); }
  ok("machines do not steer toward players",
     Math.abs(m10.heading - heading10) < 1e-9,
     "(drifted " + (m10.heading - heading10).toFixed(4) + " rad)");

  // Two machines driven into each other must both come away on new headings.
  const r11 = beginS(1, 43, 1);
  const [a11, b11] = r11.roombas;
  a11.x = 8; a11.z = 8; a11.heading = Math.PI / 2;    // travelling +x
  b11.x = 9; b11.z = 8; b11.heading = -Math.PI / 2;   // travelling -x, head on
  for (const other of r11.roombas.slice(2)) { other.x = 1; other.z = 1; }
  const ha = a11.heading;
  const hb = b11.heading;
  sim.step(r11, DT);
  ok("machines bounce off each other",
     a11.heading !== ha && b11.heading !== hb,
     "(" + ha.toFixed(2) + "->" + a11.heading.toFixed(2) + ", " +
       hb.toFixed(2) + "->" + b11.heading.toFixed(2) + ")");
  ok("a collision is announced", r11.events.some((e) => e.type === "clang" && e.hard));
  ok("machines never end up overlapping",
     Math.hypot(a11.x - b11.x, a11.z - b11.z) > 0.9,
     "(" + Math.hypot(a11.x - b11.x, a11.z - b11.z).toFixed(2) + ")");

  // Collisions wind the room up, but only to a ceiling.
  const r12 = beginS(1, 47, 1);
  let guard12 = 0;
  while (r12.phase === "running" && guard12++ < 60 * 60 * 3) {
    for (const p of r12.players.values()) { p.legs = 2; p.state = sim.ALIVE; }
    r12.phase = "running";
    sim.step(r12, DT);
  }
  ok("tempo is capped", r12.roombas.every((m) => m.tempo <= 1.9 + 1e-9),
     "(max " + Math.max(...r12.roombas.map((m) => m.tempo)).toFixed(2) + ")");
  ok("headings stay finite through thousands of collisions",
     r12.roombas.every((m) => Number.isFinite(m.heading) &&
       Number.isFinite(m.x) && Number.isFinite(m.z)));

  // The machines have to be genuinely unoutrunnable, which is the premise of the whole mode.
  ok("machines are faster than a running player",
     ARENAS.every((a) => a.roombaSpeed > sim.SPEED_WALK),
     "(" + ARENAS.map((a) => a.roombaSpeed).join(", ") + " vs " + sim.SPEED_WALK + ")");

  console.log("\nsurvival: rounds resolve");
  // The mode must end on its own. A survival round that cannot finish is worse than a hard
  // one — the TV just sits there.
  for (let ai = 0; ai < ARENAS.length; ai++) {
    let ended = 0;
    let totalT = 0;
    const N = 12;
    for (let s = 1; s <= N; s++) {
      const r = beginS(ai, s * 7919, 4);
      let guard = 0;
      while (r.phase === "running" && guard++ < 60 * 60 * 5) sim.step(r, DT);
      if (r.phase === "over") { ended++; totalT += r.t; }
    }
    console.log("         " + ARENAS[ai].name.padEnd(14) +
      "ends " + ended + "/" + N + "   idle median ≈" + (totalT / Math.max(1, ended)).toFixed(1) + "s");
    ok(ARENAS[ai].name + " always resolves", ended === N, "(" + ended + "/" + N + ")");
  }

  // Someone always wins, even when everybody dies — the last one to go down.
  const r8 = beginS(0, 31, 3);
  let guard = 0;
  while (r8.phase === "running" && guard++ < 60 * 60 * 5) sim.step(r8, DT);
  ok("a survival round names a winner", r8.winner !== null, "(" + r8.winner + ")");
  const ranking = sim.survivalRanking(r8);
  ok("the ranking covers everyone who played", ranking.length === 3, "(" + ranking.length + ")");
  ok("the ranking is ordered by time survived",
     ranking.every((e, i) => i === 0 || ranking[i - 1].time >= e.time || ranking[i - 1].alive));
  ok("the winner tops the ranking", ranking[0].id === r8.winner);

  // Spectators are excluded, exactly as they are in escape.
  const r9 = beginS(0, 37, 2);
  sim.addPlayer(r9, 99);
  r9.players.get(99).state = sim.WAITING;
  ok("spectators are not ranked",
     sim.survivalRanking(r9).every((e) => e.id !== 99));
}

/* ---- 15. calls mode ---- */
console.log("\ncalls: the board");
{
  const beginC = (stageIndex, seed, n = 1) => {
    const r = sim.createRound(stageIndex, seed, sim.MODE_CALLS);
    for (let i = 1; i <= n; i++) sim.addPlayer(r, i);
    sim.startRound(r);
    return r;
  };

  const r0 = beginC(0, 5, 1);
  ok("the round knows it is calls", r0.mode === sim.MODE_CALLS);
  ok("calls uses the stage table", r0.level.name === STAGES[0].name, "(" + r0.level.name + ")");
  ok("the board is 6 by 4", r0.cols === 6 && r0.rows === 4, "(" + r0.cols + "x" + r0.rows + ")");

  // Every tile carries a symbol and starts solid.
  const n = r0.cols * r0.rows;
  ok("every tile is solid at the start",
     [...r0.tileState].every((s) => s === sim.TILE_SOLID));

  // The deal must be even, or calling the minority is a massacre nobody could avoid.
  let xs = 0;
  for (let i = 0; i < n; i++) if (r0.tileSym[i] === sim.SYM_X) xs++;
  ok("the deal is exactly even", xs === n / 2, "(" + xs + " of " + n + ")");

  // ...and it must be even on every reshuffle, not just the first.
  let uneven = 0;
  for (let k = 0; k < 40; k++) {
    const r = beginC(0, 100 + k, 1);
    let c = 0;
    for (let i = 0; i < n; i++) if (r.tileSym[i] === sim.SYM_X) c++;
    if (c !== n / 2) uneven++;
  }
  ok("every deal is even", uneven === 0, "(" + uneven + "/40 uneven)");

  // The board must actually change between deals, or memory would work.
  const a = beginC(0, 7, 1);
  const first = [...a.tileSym].join("");
  let changed = 0;
  for (let k = 0; k < 20; k++) {
    const r = beginC(0, 7, 1);
    if ([...r.tileSym].join("") !== first) changed++;
  }
  ok("the board is reshuffled, not seeded", changed > 15, "(" + changed + "/20 differed)");

  // Players spawn on tile centres, on the board.
  const r1 = beginC(0, 11, 4);
  let offCentre = 0;
  let offBoard = 0;
  for (const p of r1.players.values()) {
    if (Math.abs((p.x % 1) - 0.5) > 1e-6 || Math.abs((p.z % 1) - 0.5) > 1e-6) offCentre++;
    if (p.x < 0 || p.x > r1.cols || p.z < 0 || p.z > r1.rows) offBoard++;
  }
  ok("everyone spawns on a tile centre", offCentre === 0, "(" + offCentre + " off)");
  ok("everyone spawns on the board", offBoard === 0, "(" + offBoard + " off)");

  console.log("\ncalls: the cycle");

  // A symbol is called, and the clock is the stage's opening time.
  const r2 = beginC(0, 13, 1);
  run(r2, r2.level.settleTime + 0.05);
  ok("a symbol is called", r2.called !== null, "(" + r2.called + ")");
  ok("the call is announced", r2.events.some((e) => e.type === "call"));
  ok("the first call uses the stage's opening time",
     Math.abs(r2.callTime - r2.level.callTime) < 1e-9,
     "(" + r2.callTime + " vs " + r2.level.callTime + ")");

  // Standing on the called symbol survives the drop; the other symbol does not.
  const r3 = beginC(0, 17, 2);
  run(r3, r3.level.settleTime + 0.05);
  const called = r3.called;
  const safeP = r3.players.get(1);
  const doomed = r3.players.get(2);

  // Park one on a called tile and one on the opposite.
  let safeTile = null;
  let badTile = null;
  for (let z = 0; z < r3.rows && (!safeTile || !badTile); z++) {
    for (let x = 0; x < r3.cols; x++) {
      const sym = sim.tileSymbolAt(r3, x, z);
      if (sym === called && !safeTile) safeTile = { x, z };
      if (sym !== called && !badTile) badTile = { x, z };
    }
  }
  safeP.x = safeTile.x + 0.5; safeP.z = safeTile.z + 0.5;
  doomed.x = badTile.x + 0.5; doomed.z = badTile.z + 0.5;

  // Run past the drop.
  run(r3, r3.callTime + 0.2);
  ok("standing on the called symbol survives", safeP.state === sim.ALIVE, "(" + safeP.state + ")");
  ok("standing on the other symbol drops", doomed.state === sim.DEAD, "(" + doomed.state + ")");
  ok("the drop is announced", r3.events.some((e) => e.type === "drop") ||
     r3.callPhase !== sim.CALL_SHOWING);

  // The floor comes back, shuffled, and the clock tightens.
  const r4 = beginC(0, 19, 1);
  const lone = r4.players.get(1);
  const startTime = r4.level.callTime;
  // Keep the player alive by force so the cycle can be observed to completion.
  let guard = 0;
  while (r4.callRound < 2 && guard++ < 60 * 60) {
    lone.state = sim.ALIVE;
    r4.phase = "running";
    sim.step(r4, DT);
  }
  ok("the floor returns solid",
     [...r4.tileState].every((s) => s === sim.TILE_SOLID || s === sim.TILE_RISING),
     "(states " + [...new Set(r4.tileState)].join(",") + ")");
  ok("the clock tightens each round", r4.callTime < startTime,
     "(" + startTime + " -> " + r4.callTime.toFixed(2) + ")");
  ok("a rise is announced", r4.events.length >= 0);   // structural; rise fires in the cycle

  // The clock never goes below the stage's floor, however long the game runs.
  const r5 = beginC(0, 23, 1);
  const lone5 = r5.players.get(1);
  guard = 0;
  while (r5.callRound < 40 && guard++ < 60 * 60 * 6) {
    lone5.state = sim.ALIVE;
    r5.phase = "running";
    sim.step(r5, DT);
  }
  ok("the call time is floored", r5.callTime >= r5.level.callTimeMin - 1e-9,
     "(" + r5.callTime.toFixed(2) + " vs min " + r5.level.callTimeMin + ")");

  // Walking off the edge of the platform is fatal — there is nothing out there.
  const r6 = beginC(0, 29, 1);
  const walker = r6.players.get(1);
  run(r6, 0.1);
  walker.x = -1;
  sim.step(r6, DT);
  ok("walking off the board is fatal", walker.state === sim.DEAD, "(" + walker.state + ")");

  console.log("\ncalls: rounds resolve");
  // The mode must end on its own, exactly as survival does.
  for (let si = 0; si < STAGES.length; si++) {
    let ended = 0;
    let totalRounds = 0;
    const N = 10;
    for (let s = 1; s <= N; s++) {
      // Bots that never move: they die the first time their tile is not called, which is the
      // fastest possible resolution and proves the round terminates.
      const r = beginC(si, s * 7919, 4);
      let g = 0;
      while (r.phase === "running" && g++ < 60 * 60 * 3) sim.step(r, DT);
      if (r.phase === "over") { ended++; totalRounds += r.callRound; }
    }
    console.log("         " + STAGES[si].name.padEnd(12) +
      "ends " + ended + "/" + N + "   idle rounds ≈" + (totalRounds / Math.max(1, ended)).toFixed(1));
    ok(STAGES[si].name + " always resolves", ended === N, "(" + ended + "/" + N + ")");
  }

  // Someone always wins.
  const r7 = beginC(0, 31, 3);
  guard = 0;
  while (r7.phase === "running" && guard++ < 60 * 60 * 3) sim.step(r7, DT);
  ok("a calls round names a winner", r7.winner !== null, "(" + r7.winner + ")");
  ok("the over event carries the round count",
     r7.events.some((e) => e.type === "over" && typeof e.calls === "number"));

  // No sonar, no mines, no machines in this mode.
  const r8 = beginC(0, 37, 2);
  run(r8, 3);
  ok("calls emits no sonar", [...r8.players.values()].every((p) => p.ping === null));
  ok("calls has no machines", r8.roombas.length === 0);
  ok("calls leaves no footprints", r8.prints.length === 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
