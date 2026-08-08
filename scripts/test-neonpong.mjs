/**
 * Neon Pong — simulation tests.
 *
 * The sim is pure and headless, so the whole game can be exercised without a browser, a
 * shell, or a room. Run with:  node scripts/test-neonpong.mjs
 *
 * The sim is imported by absolute URL in the browser (/games/neonpong/sim.js); node cannot
 * resolve that, so it is copied into a temp directory with relative specifiers and imported
 * from there. Nothing else is changed — the code under test is byte-for-byte what ships.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const GAME = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "games", "neonpong");
const OUT = mkdtempSync(join(tmpdir(), "neonpong-test-"));
for (const f of ["sim.js"]) {
  writeFileSync(join(OUT, f), readFileSync(join(GAME, f), "utf8").replace(/\/games\/neonpong\//g, "./"));
}

const sim = await import(pathToFileURL(join(OUT, "sim.js")).href);
const {
  createMatch, addPlayer, removePlayer, setInput, step, restart, assignSeats,
  paddleBox, FIELD, BALL_R, PADDLE_LEN, WALLS, SEAT_ORDER, BOTTOM, TOP, LEFT, RIGHT,
  LIVES_START, BALL_SPEED_MAX,
} = sim;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + " " + extra); }
};

const DT = 1 / 60;

/**
 * Drive the sim for `seconds`.
 *
 * `drive` sets input before each step; `watch` inspects the events that step produced and is
 * then responsible for nothing — the harness drains the log itself. The screen drains
 * `match.events` every frame, so a headless run that let it accumulate would re-examine every
 * past event on every subsequent frame and report wildly inflated counts.
 */
function run(match, seconds, drive, watch) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (drive) drive(match, i * DT);
    step(match, DT);
    if (watch) watch(match, match.events);
    match.events.length = 0;
  }
}

/** A match with `n` players already seated and serving. */
function fresh(n, seed = 7) {
  const m = createMatch(seed);
  for (let i = 1; i <= n; i++) addPlayer(m, i);
  assignSeats(m);
  restart(m);
  return m;
}

/** Perfect defence: track the ball along the wall's axis with a proportional controller. */
function autoDefend(m) {
  for (const p of m.players.values()) {
    if (p.out) continue;
    const w = WALLS[p.wall];
    const target = w.axis === "x" ? m.ball.x : m.ball.y;
    const err = target - p.pos;
    setInput(m, p.id, Math.max(-1, Math.min(1, err / 40)));
  }
}

/* ---- 1. seating ---- */
console.log("\nseating");
{
  const m = createMatch(1);
  addPlayer(m, 1);
  addPlayer(m, 2);
  ok("first two players face each other",
    m.players.get(1).wall === BOTTOM && m.players.get(2).wall === TOP,
    "(" + m.players.get(1).wall + "," + m.players.get(2).wall + ")");

  addPlayer(m, 3);
  addPlayer(m, 4);
  const walls = [...m.players.values()].map((p) => p.wall).sort();
  ok("four players take four distinct walls", new Set(walls).size === 4, "(" + walls + ")");

  ok("a fifth player is refused", addPlayer(m, 5) === null && m.players.size === 4);

  // Device ids have gaps; the seat map must survive one.
  removePlayer(m, 2);
  assignSeats(m);
  const seats = [...m.players.keys()].sort((a, b) => a - b).map((id) => m.players.get(id).wall);
  ok("seats repack after a disconnect", new Set(seats).size === 3 && seats[0] === SEAT_ORDER[0],
    "(" + seats + ")");
}

/* ---- 2. paddle movement ---- */
console.log("\npaddle movement");
{
  const m = fresh(4);
  const p = m.players.get(1);
  const start = p.pos;
  setInput(m, 1, 1);
  run(m, 0.5);
  ok("input moves the paddle", p.pos > start + 100, "(" + p.pos.toFixed(1) + ")");

  setInput(m, 1, 1);
  run(m, 5);
  const limit = FIELD / 2 + (FIELD / 2 - PADDLE_LEN / 2);
  ok("paddle stops at the field edge", Math.abs(p.pos - limit) < 1e-6,
    "(" + p.pos.toFixed(2) + " vs " + limit + ")");

  const box = paddleBox(p);
  ok("paddle stays inside the field", box.x >= -1e-6 && box.x + box.w <= FIELD + 1e-6,
    "(" + box.x.toFixed(1) + ".." + (box.x + box.w).toFixed(1) + ")");

  ok("a pinned paddle reports zero velocity", Math.abs(p.vel) < 1e-6, "(" + p.vel + ")");

  setInput(m, 1, 5);          // out of range: the wire is not trusted
  step(m, DT);
  ok("input is clamped to -1..1", p.input === 1, "(" + p.input + ")");
}

/* ---- 3. serving ---- */
console.log("\nserving");
{
  const m = fresh(2);
  ok("a round opens on a serve", m.phase === "serve" && !m.ball.live);
  ok("the ball is parked centre", m.ball.x === FIELD / 2 && m.ball.y === FIELD / 2);

  run(m, 2);
  ok("the serve becomes a rally", m.phase === "rally" && m.ball.live, "(" + m.phase + ")");

  const speed = Math.hypot(m.ball.vx, m.ball.vy);
  ok("the served ball is at exactly the start speed",
    Math.abs(speed - sim.BALL_SPEED_START) < 1e-6, "(" + speed.toFixed(3) + ")");

  // Determinism: the same seed must produce the same serve, or a replay proves nothing.
  const a = fresh(4, 99);
  const b = fresh(4, 99);
  run(a, 2);
  run(b, 2);
  ok("serves are deterministic for a seed",
    a.ball.vx === b.ball.vx && a.ball.vy === b.ball.vy);
}

/* ---- 4. bouncing and scoring ---- */
console.log("\nbouncing and scoring");
{
  // Two players: the left and right walls are unmanned, so they must bounce, never score.
  const m = fresh(2);
  run(m, 20, autoDefend);
  const lives = [...m.players.values()].map((p) => p.lives);
  ok("a perfect defence concedes nothing in 20s", lives.every((l) => l === LIVES_START),
    "(" + lives + ")");
  ok("the rally is still live", m.phase === "rally", "(" + m.phase + ")");
  ok("the ball stayed inside the field",
    m.ball.x > -BALL_R * 2 && m.ball.x < FIELD + BALL_R * 2 &&
    m.ball.y > -BALL_R * 2 && m.ball.y < FIELD + BALL_R * 2,
    "(" + m.ball.x.toFixed(1) + "," + m.ball.y.toFixed(1) + ")");
  ok("a rally builds hits", m.rally > 3, "(" + m.rally + ")");
}
{
  // Nobody defends: every wall is open, so the ball can never score and the game never ends.
  const m = fresh(1);
  run(m, 2);
  const only = m.players.get(1);
  // Park the lone paddle out of the way and let the ball run.
  run(m, 30, (mm) => setInput(mm, 1, 0));
  ok("a solo player can lose lives", only.lives < LIVES_START, "(" + only.lives + ")");
  ok("a solo game ends when lives run out", only.lives > 0 || m.phase === "over",
    "(" + m.phase + ")");
}
{
  // A conceded goal must charge the wall's own defender, not whoever hit it last.
  const m = fresh(4);
  run(m, 2);
  // Everyone stands aside; whichever wall the ball reaches first pays for it.
  run(m, 6, (mm) => { for (const p of mm.players.values()) setInput(mm, p.id, 0); });
  const lost = [...m.players.values()].filter((p) => p.lives < LIVES_START);
  ok("an undefended goal costs exactly its own defender a life",
    lost.length >= 1 && lost.every((p) => p.lives < LIVES_START), "(" + lost.length + ")");
}

/* ---- 5. no tunnelling at max speed ---- */
console.log("\ntunnelling");
{
  // Drive a long rally so the ball reaches its speed cap, then check it never passed a
  // defended wall without being scored. A tunnel shows up as the ball leaving the field.
  const m = fresh(4);
  let worst = 0;
  run(m, 60, (mm) => {
    autoDefend(mm);
    const out = Math.max(
      -mm.ball.x, mm.ball.x - FIELD, -mm.ball.y, mm.ball.y - FIELD
    );
    if (out > worst) worst = out;
  });
  ok("the ball never escapes the field", worst < BALL_R + 2, "(" + worst.toFixed(2) + "px past)");

  const speed = Math.hypot(m.ball.vx, m.ball.vy);
  ok("the ball speed is capped", speed <= BALL_SPEED_MAX + 1e-6, "(" + speed.toFixed(1) + ")");

  const perfect = [...m.players.values()].every((p) => p.lives === LIVES_START);
  ok("a perfect defence survives a 60s rally at max speed", perfect,
    "(" + [...m.players.values()].map((p) => p.lives) + ")");
}

/* ---- 6. reflection angles ---- */
console.log("\nreflection");
{
  // A ball returned off a paddle must always come back into the field, and never end up
  // crawling parallel to the wall it just hit.
  const m = fresh(4);
  let shallow = 0, wrongWay = 0, hits = 0;
  run(m, 40, autoDefend, (mm, events) => {
    for (const e of events) {
      if (e.type !== "paddle") continue;
      hits++;
      const w = WALLS[e.wall];
      const normal = w.perp === "y" ? mm.ball.vy : mm.ball.vx;
      const speed = Math.hypot(mm.ball.vx, mm.ball.vy);
      if (normal * w.normal <= 0) wrongWay++;
      if (Math.abs(normal) / speed < 0.29) shallow++;
    }
  });
  ok("there were hits to check", hits > 10, "(" + hits + ")");
  ok("every return heads into the field", wrongWay === 0, "(" + wrongWay + " of " + hits + ")");
  ok("no return crawls along the wall", shallow === 0, "(" + shallow + " of " + hits + ")");
}

/* ---- 7. elimination and winning ---- */
console.log("\nelimination");
{
  const m = fresh(2);
  // Player 1 defends perfectly; player 2 never moves and must be eliminated.
  run(m, 120, (mm) => {
    if (mm.phase !== "rally") return;
    const p = mm.players.get(1);
    if (p && !p.out) {
      const w = WALLS[p.wall];
      const target = w.axis === "x" ? mm.ball.x : mm.ball.y;
      setInput(mm, 1, Math.max(-1, Math.min(1, (target - p.pos) / 40)));
    }
    setInput(mm, 2, 0);
  });
  ok("a player who never moves is eliminated", m.players.get(2).out, "(lives " + m.players.get(2).lives + ")");
  ok("the match ends", m.phase === "over", "(" + m.phase + ")");
  ok("the survivor wins", m.winner === 1, "(" + m.winner + ")");
}
{
  // Restart must clear elimination, lives and the winner, or a second round starts broken.
  const m = fresh(2);
  m.players.get(2).lives = 0;
  m.players.get(2).out = true;
  m.phase = "over";
  m.winner = 1;
  restart(m);
  const clean = [...m.players.values()].every((p) => p.lives === LIVES_START && !p.out);
  ok("restart resets the roster", clean && m.winner === null && m.phase === "serve");
}

/* ---- 8. mid-match disconnect ---- */
console.log("\ndisconnects");
{
  const m = fresh(4);
  run(m, 5, autoDefend);
  removePlayer(m, 3);
  assignSeats(m);
  run(m, 10, autoDefend);
  ok("the sim survives losing a player mid-rally", m.players.size === 3);
  ok("the ball is still in the field",
    m.ball.x > -BALL_R * 2 && m.ball.x < FIELD + BALL_R * 2 &&
    m.ball.y > -BALL_R * 2 && m.ball.y < FIELD + BALL_R * 2);
}

/* ---- summary ---- */
console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
