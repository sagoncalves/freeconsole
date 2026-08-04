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
const { LEVELS } = await import(pathToFileURL(join(OUT, "levels.js")).href);

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
  const r = begin(0, 31, 1);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  r.players.get(1).x = 1.5;
  sim.setInput(r, 1, "up", true);
  run(r, 3);
  ok("walking leaves prints", r.prints.length > 3, "(" + r.prints.length + ")");
  ok("prints are attributed to the walker", r.prints.every((p) => p.id === 1));

  const before = r.prints.length;
  sim.clearInput(r, 1);
  run(r, sim.PRINT_LIFE + 2);
  ok("prints expire", r.prints.length < before, "(" + before + " -> " + r.prints.length + ")");
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
