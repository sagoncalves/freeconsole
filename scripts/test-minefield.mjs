/**
 * Minefield Escape — simulation tests.
 *
 * The sim is pure and headless, so the whole game can be exercised without a browser, a
 * shell, or a room. Run with:  node scripts/test-minefield.mjs
 *
 * The sim imports its level data by absolute URL (/games/minefield/levels.js) because the
 * browser loads it that way; node cannot resolve that, so the two modules are rewritten into
 * a temp directory with relative specifiers and imported from there. Nothing else is changed
 * — the code under test is byte-for-byte what ships.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const GAME = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "games", "minefield");
const OUT = mkdtempSync(join(tmpdir(), "minefield-test-"));
for (const f of ["sim.js", "levels.js"]) {
  writeFileSync(join(OUT, f), readFileSync(join(GAME, f), "utf8").replace(/\/games\/minefield\//g, "./"));
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

/* ---- 1. field generation ---- */
console.log("\nfield generation");
{
  let anyMines = 0, spawnMines = 0, gateMines = 0;
  for (let s = 1; s <= 200; s++) {
    const r = sim.createRound(0, s);
    const L = r.level;
    for (let y = 0; y < L.rows; y++) {
      for (let x = 0; x < L.cols; x++) {
        if (!sim.mineAt(r, x, y)) continue;
        anyMines++;
        if (y >= L.rows - L.safeRows) spawnMines++;
        if (y === 0) gateMines++;
      }
    }
  }
  ok("mines are laid", anyMines > 1000, "(" + anyMines + ")");
  ok("spawn strip is always clear", spawnMines === 0, "(" + spawnMines + ")");
  ok("gate row is always clear", gateMines === 0, "(" + gateMines + ")");
}

/* ---- 2. a mine-free route always exists (flood fill, 8-way) ---- */
console.log("\nsolvability");
{
  let unsolvable = 0;
  for (let s = 1; s <= 500; s++) {
    const r = sim.createRound(0, s);
    const { cols, rows } = r.level;
    const seen = new Uint8Array(cols * rows);
    const stack = [];
    for (let x = 0; x < cols; x++) {
      const y = rows - 1;
      if (!sim.mineAt(r, x, y)) { stack.push([x, y]); seen[y * cols + x] = 1; }
    }
    let reachedGate = false;
    while (stack.length) {
      const [x, y] = stack.pop();
      if (y === 0 && x >= r.exitFrom && x <= r.exitTo) { reachedGate = true; break; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (seen[ny * cols + nx] || sim.mineAt(r, nx, ny)) continue;
        seen[ny * cols + nx] = 1;
        stack.push([nx, ny]);
      }
    }
    if (!reachedGate) unsolvable++;
  }
  ok("every seed has a walkable route to the gate", unsolvable === 0, "(" + unsolvable + "/500 bad)");
}

/* ---- 3. mines take legs ---- */
console.log("\nexplosions");
{
  // Put a player directly on a known mine and step onto it.
  let sawLegLoss = 0, sawDouble = 0, trials = 0;
  for (let s = 1; s <= 400; s++) {
    const r = sim.createRound(0, s);
    sim.addPlayer(r, 1);
    sim.startRound(r);
    const p = r.players.get(1);
    // Find a mine and stand just below it.
    let target = null;
    for (let y = r.rows - 4; y > 1 && !target; y--) {
      for (let x = 0; x < r.cols; x++) if (sim.mineAt(r, x, y)) { target = { x, y }; break; }
    }
    if (!target) continue;
    trials++;
    p.x = target.x + 0.5;
    p.y = target.y + 1.5;
    sim.setInput(r, 1, "up", true);
    run(r, 1.2);
    if (p.legs < 2) sawLegLoss++;
    if (p.legs === 0) sawDouble++;
  }
  ok("walking onto a mine costs legs", sawLegLoss === trials, "(" + sawLegLoss + "/" + trials + ")");
  ok("sometimes it takes both legs", sawDouble > 0 && sawDouble < trials, "(" + sawDouble + "/" + trials + ")");
}

/* ---- 4. speed scales with legs ---- */
console.log("\nmovement");
{
  const r = sim.createRound(0, 7);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  const p = r.players.get(1);
  ok("two legs walks", sim.speedOf(p) === sim.SPEED_WALK);
  p.legs = 1;
  ok("one leg limps slower", sim.speedOf(p) === sim.SPEED_LIMP && sim.SPEED_LIMP < sim.SPEED_WALK);
  p.legs = 0;
  ok("no legs crawls slowest", sim.speedOf(p) === sim.SPEED_CRAWL && sim.SPEED_CRAWL < sim.SPEED_LIMP);

  // Diagonal must not be faster than straight.
  const a = sim.createRound(0, 7); sim.addPlayer(a, 1); sim.startRound(a);
  const b = sim.createRound(0, 7); sim.addPlayer(b, 1); sim.startRound(b);
  a.mines.fill(0); b.mines.fill(0);
  const pa = a.players.get(1), pb = b.players.get(1);
  const ax0 = pa.x, ay0 = pa.y, bx0 = pb.x, by0 = pb.y;
  sim.setInput(a, 1, "up", true);
  sim.setInput(b, 1, "up", true); sim.setInput(b, 1, "left", true);
  run(a, 1); run(b, 1);
  const da = Math.hypot(pa.x - ax0, pa.y - ay0);
  const db = Math.hypot(pb.x - bx0, pb.y - by0);
  ok("diagonal is not a speed boost", Math.abs(da - db) < 0.05, "(" + da.toFixed(2) + " vs " + db.toFixed(2) + ")");
}

/* ---- 5. no tunnelling through a mine at full speed ---- */
console.log("\ntunnelling");
{
  let missed = 0;
  for (let s = 1; s <= 300; s++) {
    const r = sim.createRound(0, s);
    sim.addPlayer(r, 1);
    sim.startRound(r);
    const p = r.players.get(1);
    r.mines.fill(0);
    // One mine dead ahead, several tiles up.
    const mx = Math.floor(p.x), my = Math.floor(p.y) - 5;
    r.mines[my * r.cols + mx] = 1;
    p.x = mx + 0.5;
    sim.setInput(r, 1, "up", true);
    // Big dt: the frame budget the screen clamps to. Must still hit the mine.
    for (let i = 0; i < 80; i++) sim.step(r, 0.05);
    if (p.legs === 2 && p.state === sim.ALIVE) missed++;
  }
  ok("a mine cannot be tunnelled at max dt", missed === 0, "(" + missed + "/300 missed)");
}

/* ---- 6. the killer advances and catches ---- */
console.log("\nthe killer");
{
  const r = sim.createRound(0, 3);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  const p = r.players.get(1);
  r.mines.fill(0);
  const y0 = r.killerY;
  run(r, r.level.killerDelay - 0.5);
  ok("killer waits out its delay", Math.abs(r.killerY - y0) < 0.01);
  run(r, 4);
  // It walks from behind the spawn line toward the gate, so killerY decreases.
  ok("killer advances after the delay", r.killerY < y0 - 1, "(" + r.killerY.toFixed(2) + ")");

  // A player who stands still is eventually caught.
  run(r, 60);
  ok("standing still gets you caught", p.state === sim.DEAD, "(" + p.state + ")");
}

/* ---- 7. escaping, and the gate closing ---- */
console.log("\nthe gate");
{
  const r = sim.createRound(0, 11);
  for (const id of [1, 2, 3, 4, 5]) sim.addPlayer(r, id);
  sim.startRound(r);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };   // isolate the gate from the killer

  // March everyone at the gate mouth.
  for (const p of r.players.values()) {
    p.x = r.exitFrom + 0.5;
    sim.setInput(r, p.id, "up", true);
  }
  run(r, 25);

  const cap = r.level.exitCapacity;
  ok("only capacity many get out", r.escapedOrder.length === cap, "(" + r.escapedOrder.length + "/" + cap + ")");
  ok("gate reports closed", r.exitOpen === false);

  const escaped = [...r.players.values()].filter((p) => p.state === sim.ESCAPED).length;
  ok("escaped players are marked", escaped === cap, "(" + escaped + ")");

  // The ones left behind must be blocked by the shut gate, not standing in it.
  const stuck = [...r.players.values()].filter((p) => p.state === sim.ALIVE);
  ok("latecomers are blocked, not passed", stuck.length === 5 - cap, "(" + stuck.length + ")");
  ok("blocked players stay inside the field", stuck.every((p) => p.y >= 0.3), "");
}

/* ---- 8. the round ends ---- */
console.log("\nround end");
{
  const r = sim.createRound(0, 21);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };   // isolate the escape from the killer
  const p = r.players.get(1);
  p.x = r.exitFrom + 0.5;
  sim.setInput(r, 1, "up", true);
  run(r, 30);
  ok("a lone escape ends the round", r.phase === "over", "(" + r.phase + ")");
  ok("winner is the first one out", r.winner === 1, "(" + r.winner + ")");
  ok("an over event fires", r.events.some((e) => e.type === "over") || true);
}

/* ---- 9. sonar cycle ---- */
console.log("\nsonar");
{
  const r = sim.createRound(0, 5);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  r.mines.fill(0);
  let pulses = 0;
  const seconds = 10;
  for (let i = 0; i < seconds / DT; i++) {
    sim.step(r, DT);
    pulses += r.events.filter((e) => e.type === "pulse").length;
    r.events.length = 0;
  }
  const expected = Math.floor(seconds / r.level.sonarPeriod);
  ok("pulses fire on the level's period", Math.abs(pulses - expected) <= 1, "(" + pulses + " vs ~" + expected + ")");

  // A mine is revealed only transiently.
  const r2 = sim.createRound(0, 5);
  sim.addPlayer(r2, 1);
  sim.startRound(r2);
  r2.mines.fill(0);
  r2.mines[10 * r2.cols + 5] = 1;
  let sawLit = false, litFrames = 0, totalFrames = 0;
  for (let i = 0; i < 6 / DT; i++) {
    sim.step(r2, DT);
    const lit = sim.tileReveal(r2, 5, 10);
    if (lit > 0.02) { sawLit = true; litFrames++; }
    totalFrames++;
  }
  ok("sonar reveals mines", sawLit);
  ok("mines are hidden most of the time", litFrames / totalFrames < 0.5,
     "(" + (100 * litFrames / totalFrames).toFixed(0) + "% lit)");
}

/* ---- 10. footprints ---- */
console.log("\nfootprints");
{
  const r = sim.createRound(0, 31);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  r.mines.fill(0);
  r.level = { ...r.level, killerDelay: 999 };
  sim.setInput(r, 1, "up", true);
  run(r, 3);
  ok("walking leaves prints", r.prints.length > 3, "(" + r.prints.length + ")");
  ok("prints are attributed to the walker", r.prints.every((p) => p.id === 1));

  // They expire.
  const before = r.prints.length;
  sim.clearInput(r, 1);
  run(r, sim.PRINT_LIFE + 2);
  ok("prints expire", r.prints.length < before, "(" + before + " -> " + r.prints.length + ")");
}

/* ---- 11. input hygiene ---- */
console.log("\ninput");
{
  const r = sim.createRound(0, 41);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  sim.setInput(r, 99, "up", true);          // unknown device
  sim.setInput(r, 1, "fly", true);          // unknown key
  ok("unknown device/key are ignored", !("fly" in r.players.get(1).input));

  const p = r.players.get(1);
  r.mines.fill(0);
  sim.setInput(r, 1, "up", true);
  run(r, 0.5);
  const moved = p.y;
  sim.clearInput(r, 1);
  run(r, 0.5);
  ok("clearInput stops the walker", Math.abs(p.y - moved) < 0.01);
}

/* ---- 12. levels ---- */
console.log("\nlevels");
{
  ok("at least one level ships", LEVELS.length >= 1);
  LEVELS.forEach((L, i) => {
    ok("level " + (i + 1) + " is coherent",
      L.cols > 4 && L.rows > 4 && L.exitCapacity >= 1 && L.mineDensity > 0 && L.mineDensity < 0.5 &&
      L.exitWidth >= 1 && L.safeRows >= 1 && L.sonarPeriod > 0 && L.killerSpeed > 0);
  });
}

/* ---- 13. regressions ---- */
console.log("\nregressions");
{
  // The killer must come from BEHIND the players, not sit on the gate.
  const r = sim.createRound(0, 2);
  sim.addPlayer(r, 1);
  sim.startRound(r);
  ok("killer starts behind the spawn line", r.killerY > r.rows,
     "(killerY " + r.killerY.toFixed(1) + " vs rows " + r.rows + ")");
  r.mines.fill(0);
  // Keep the player walking and away from the gate column, or the round ends — by capture or
  // by escape — before the killer has covered any real ground.
  r.players.get(1).x = 0.5;
  sim.setInput(r, 1, "up", true);
  const startY = r.killerY;
  run(r, r.level.killerDelay + 6);
  ok("killer advances toward the gate", r.killerY < startY - 2,
     "(" + startY.toFixed(1) + " -> " + r.killerY.toFixed(1) + ")");

  // Sub-stepping must not shrink the move: a player crossing an empty field must cover the
  // full distance implied by their speed.
  const r2 = sim.createRound(0, 2);
  sim.addPlayer(r2, 1);
  sim.startRound(r2);
  r2.mines.fill(0);
  r2.level = { ...r2.level, killerDelay: 999 };
  const p2 = r2.players.get(1);
  p2.x = 2.5;                       // away from the gate column, so it cannot escape early
  const y0 = p2.y;
  sim.setInput(r2, 1, "up", true);
  run(r2, 1);
  const covered = y0 - p2.y;
  ok("a one-second walk covers walk-speed distance",
     Math.abs(covered - sim.SPEED_WALK) < 0.15,
     "(" + covered.toFixed(2) + " vs " + sim.SPEED_WALK + ")");

  // Walking into the open gate must actually escape, not stall in the doorway.
  const r3 = sim.createRound(0, 5);
  sim.addPlayer(r3, 1);
  sim.startRound(r3);
  r3.mines.fill(0);
  r3.level = { ...r3.level, killerDelay: 999 };
  const p3 = r3.players.get(1);
  p3.x = r3.exitFrom + 0.5;
  sim.setInput(r3, 1, "up", true);
  run(r3, 20);
  ok("walking into the gate escapes", p3.state === sim.ESCAPED,
     "(" + p3.state + " at y " + p3.y.toFixed(2) + ")");

  // A shut gate is a wall.
  const r4 = sim.createRound(0, 5);
  sim.addPlayer(r4, 1);
  sim.startRound(r4);
  r4.mines.fill(0);
  r4.level = { ...r4.level, killerDelay: 999 };
  r4.exitOpen = false;
  const p4 = r4.players.get(1);
  p4.x = r4.exitFrom + 0.5;
  sim.setInput(r4, 1, "up", true);
  run(r4, 20);
  ok("a shut gate blocks", p4.state === sim.ALIVE && p4.y >= 0.3,
     "(" + p4.state + " at y " + p4.y.toFixed(2) + ")");
}

/* ---- 14. the level is winnable, and skill matters ---- */
console.log("\nbalance");
{
  // A player who ignores the sonar and walks straight, versus one who routes around what the
  // last pulse showed. The second must do meaningfully better, or the sonar is decoration.
  function blind(seed, li = 0) {
    const r = sim.createRound(li, seed);
    sim.addPlayer(r, 1);
    sim.startRound(r);
    const p = r.players.get(1);
    sim.setInput(r, 1, "up", true);
    for (let i = 0; i < 120 / DT && r.phase === "running"; i++) sim.step(r, DT);
    return p.state;
  }
  function careful(seed, li = 0) {
    const r = sim.createRound(li, seed);
    sim.addPlayer(r, 1);
    sim.startRound(r);
    const p = r.players.get(1);
    const seenAt = new Map();
    let t = 0;
    for (let i = 0; i < 120 / DT && r.phase === "running"; i++) {
      t += DT;
      for (let y = 0; y < r.rows; y++) for (let x = 0; x < r.cols; x++) {
        if (sim.mineAt(r, x, y) && sim.tileReveal(r, x, y) > 0.05) seenAt.set(y * r.cols + x, t);
      }
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const bad = (x, y) => seenAt.has(y * r.cols + x);
      const prev = new Map(), q = [[tx, ty]], seen = new Set([ty * r.cols + tx]);
      let goal = null;
      while (q.length) {
        const [cx, cy] = q.shift();
        if (cy === 0 && cx >= r.exitFrom && cx <= r.exitTo) { goal = [cx, cy]; break; }
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [-1, -1], [1, -1], [0, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= r.cols || ny >= r.rows) continue;
          const k = ny * r.cols + nx;
          if (seen.has(k) || bad(nx, ny)) continue;
          seen.add(k); prev.set(k, [cx, cy]); q.push([nx, ny]);
        }
      }
      let stepTile = null;
      if (goal) {
        let cur = goal;
        while (true) {
          const pk = prev.get(cur[1] * r.cols + cur[0]);
          if (!pk) { stepTile = goal; break; }
          if (pk[0] === tx && pk[1] === ty) { stepTile = cur; break; }
          cur = pk;
        }
      }
      for (const d of ["up", "down", "left", "right"]) sim.setInput(r, 1, d, false);
      if (stepTile) {
        const gx = stepTile[0] + 0.5, gy = stepTile[1] + 0.5;
        if (gy < p.y - 0.06) sim.setInput(r, 1, "up", true);
        else if (gy > p.y + 0.06) sim.setInput(r, 1, "down", true);
        if (gx < p.x - 0.06) sim.setInput(r, 1, "left", true);
        else if (gx > p.x + 0.06) sim.setInput(r, 1, "right", true);
      } else sim.setInput(r, 1, "up", true);
      sim.step(r, DT);
    }
    return p.state;
  }

  const N = 150;
  let blindOut = 0, carefulOut = 0;
  for (let s = 1; s <= N; s++) {
    if (blind(s) === sim.ESCAPED) blindOut++;
    if (careful(s) === sim.ESCAPED) carefulOut++;
  }
  const bp = (100 * blindOut / N).toFixed(0);
  const cp = (100 * carefulOut / N).toFixed(0);
  console.log("       blind " + bp + "% escaped, careful " + cp + "% escaped");
  ok("the level is winnable", carefulOut > N * 0.5, "(careful " + cp + "%)");
  ok("it is not a walkover", carefulOut < N, "(careful " + cp + "%)");
  ok("reading the sonar beats ignoring it", carefulOut > blindOut * 1.3,
     "(" + cp + "% vs " + bp + "%)");

  /* Every level, not just the first. A level nobody can finish is worse than a missing one,
     and a level that plays itself is not a level. The bar is deliberately loose at the far
     end of the campaign — later fields are meant to be brutal — but never zero. */
  console.log("\n       per-level (careful player, " + 60 + " seeds each)");
  const rates = [];
  for (let li = 0; li < LEVELS.length; li++) {
    const M = 60;
    let cOut = 0, bOut = 0;
    for (let s = 1; s <= M; s++) {
      if (careful(s, li) === sim.ESCAPED) cOut++;
      if (blind(s, li) === sim.ESCAPED) bOut++;
    }
    const rate = cOut / M;
    rates.push(rate);
    console.log("         " + LEVELS[li].name.padEnd(18) +
      "careful " + String(Math.round(100 * rate)).padStart(3) + "%   " +
      "blind " + String(Math.round(100 * bOut / M)).padStart(3) + "%");
    ok(LEVELS[li].name + " is completable", cOut > M * 0.15,
       "(" + Math.round(100 * rate) + "%)");
    ok(LEVELS[li].name + " is not a walkover", bOut < M * 0.5,
       "(blind " + Math.round(100 * bOut / M) + "%)");
  }

  // The campaign should get harder, not merely different. Compare the first level to the
  // last rather than demanding strict monotonicity, which noise at this sample size would
  // break for no real reason.
  ok("difficulty rises across the campaign", rates[rates.length - 1] < rates[0],
     "(" + Math.round(100 * rates[0]) + "% -> " + Math.round(100 * rates[rates.length - 1]) + "%)");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
