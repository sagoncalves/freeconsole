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
  paddleAt, sideGeometry, verticesFor, sideCountFor, defenderOf, damageColor, isWideArena,
  FIELD, CENTER, RADIUS, BALL_R, WALL_HP, MAX_PLAYERS, BALL_SPEED_MAX, DAMAGE_COLORS,
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
 * `drive` sets input before each step; `watch` inspects the events that step produced. The
 * harness drains the log itself — the screen drains `match.events` every frame, so a headless
 * run that let it accumulate would re-examine every past event on every subsequent frame.
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
  restart(m);
  return m;
}

/**
 * Perfect defence: slide each paddle so its centre tracks the ball's projection onto its own
 * edge. Expressed in edge-fraction units, which is what the sim's `t` uses.
 */
function autoDefend(m) {
  for (const p of m.players.values()) {
    if (p.out) continue;
    const g = sideGeometry(m.sides, p.side);
    const along = ((m.ball.x - g.a.x) * g.dx + (m.ball.y - g.a.y) * g.dy) / g.len;
    setInput(m, p.id, Math.max(-1, Math.min(1, (along - p.t) * 12)));
  }
}

/** True when the ball is inside the polygon, allowing a small skin for the radius. */
function inside(m, slack = BALL_R * 4) {
  return Math.hypot(m.ball.x - CENTER, m.ball.y - CENTER) <= RADIUS + slack;
}

/* ---- 1. polygon geometry ---- */
console.log("\npolygon geometry");
{
  ok("1-2 players fall back to a square",
    sideCountFor(1) === 4 && sideCountFor(2) === 4);
  ok("3+ players get one side each",
    [3, 4, 5, 6, 7, 8].every((n) => sideCountFor(n) === n));
  ok("the polygon is capped at 8 sides", sideCountFor(99) === 8);

  for (let n = 3; n <= MAX_PLAYERS; n++) {
    const verts = verticesFor(n);
    const radii = verts.map((v) => Math.hypot(v.x - CENTER, v.y - CENTER));
    const lens = [];
    for (let i = 0; i < n; i++) lens.push(sideGeometry(n, i).len);
    const rOk = radii.every((r) => Math.abs(r - RADIUS) < 1e-9);
    const lOk = lens.every((l) => Math.abs(l - lens[0]) < 1e-9);
    ok(n + "-gon is regular", rOk && lOk,
      "(r spread " + (Math.max(...radii) - Math.min(...radii)).toExponential(1) + ")");
  }

  // Every inward normal must actually point at the centre, or reflections go the wrong way.
  let badNormals = 0;
  for (let n = 3; n <= MAX_PLAYERS; n++) {
    for (let i = 0; i < n; i++) {
      const g = sideGeometry(n, i);
      if ((CENTER - g.mx) * g.nx + (CENTER - g.my) * g.ny <= 0) badNormals++;
    }
  }
  ok("every inward normal points at the centre", badNormals === 0, "(" + badNormals + ")");

  // Side 0 faces left, so a 2-player game is head-to-head across a widescreen display.
  const sq = sideGeometry(4, 0);
  ok("side 0 is the left wall", sq.mx < CENTER - RADIUS * 0.6 && Math.abs(sq.my - CENTER) < 1e-9,
    "(" + sq.mx.toFixed(1) + "," + sq.my.toFixed(1) + ")");
}

/* ---- 1b. the wide 1-2 player court ---- */
console.log("\nwide court");
{
  const bounds = (n, wide) => {
    const v = verticesFor(n, wide);
    const xs = v.map((p) => p.x), ys = v.map((p) => p.y);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };

  ok("1-2 players get the wide arena", isWideArena(1) && isWideArena(2));
  ok("3+ players never get it", ![3, 4, 5, 6, 7, 8].some((n) => isWideArena(n)));

  const wide = bounds(4, true);
  ok("the 2-player court is a rectangle, not a square", wide.w > wide.h * 1.3,
    "(" + wide.w.toFixed(0) + " x " + wide.h.toFixed(0) + ")");
  ok("it is wider than it is tall by the stretch factor",
    Math.abs(wide.w / wide.h - 1.5) < 1e-9, "(" + (wide.w / wide.h).toFixed(3) + ":1)");
  ok("it is no wider than the square it replaces", wide.w <= bounds(4, false).w + 1e-9,
    "(" + wide.w.toFixed(0) + " vs " + bounds(4, false).w.toFixed(0) + ")");

  // The left and right walls are the short sides; top and bottom are the long open ones.
  const left = sideGeometry(4, 0, true);
  const top = sideGeometry(4, 1, true);
  ok("the defended walls are the short sides", left.len < top.len,
    "(left " + left.len.toFixed(0) + " vs top " + top.len.toFixed(0) + ")");

  // A real polygon must never be stretched, or seats would have unequal walls.
  for (let n = 3; n <= 8; n++) {
    const m = createMatch(1);
    for (let i = 1; i <= n; i++) addPlayer(m, i);
    restart(m);
    const lens = [];
    for (let i = 0; i < m.sides; i++) lens.push(sideGeometry(m.sides, i, m.wide).len);
    ok(n + " players: every side is the same length",
      lens.every((l) => Math.abs(l - lens[0]) < 1e-9),
      "(spread " + (Math.max(...lens) - Math.min(...lens)).toExponential(1) + ")");
  }

  // Two players face each other across the long axis of the rectangle.
  const m2 = createMatch(1);
  addPlayer(m2, 1);
  addPlayer(m2, 2);
  restart(m2);
  const a = sideGeometry(m2.sides, m2.players.get(1).side, m2.wide);
  const b = sideGeometry(m2.sides, m2.players.get(2).side, m2.wide);
  ok("the two players sit on opposite ends of the long axis",
    m2.wide && Math.abs(a.my - b.my) < 1e-9 && Math.abs(a.mx - b.mx) > RADIUS,
    "(" + a.mx.toFixed(0) + " vs " + b.mx.toFixed(0) + ")");
}

/* ---- 2. seating ---- */
console.log("\nseating");
{
  const m = createMatch(1);
  addPlayer(m, 1);
  addPlayer(m, 2);
  ok("two players sit opposite each other on the square",
    m.sides === 4 && Math.abs(m.players.get(1).side - m.players.get(2).side) === 2,
    "(" + m.players.get(1).side + "," + m.players.get(2).side + ")");

  for (let i = 3; i <= 8; i++) addPlayer(m, i);
  ok("eight players fit", m.players.size === 8 && m.sides === 8);
  const sides = [...m.players.values()].map((p) => p.side).sort((a, b) => a - b);
  ok("eight players take eight distinct sides",
    new Set(sides).size === 8 && sides[0] === 0 && sides[7] === 7, "(" + sides + ")");

  ok("a ninth player is refused", addPlayer(m, 9) === null && m.players.size === 8);

  // Device ids have gaps; the polygon must repack around one.
  removePlayer(m, 4);
  ok("the polygon shrinks when a player leaves", m.sides === 7, "(" + m.sides + ")");
  const after = [...m.players.values()].map((p) => p.side).sort((a, b) => a - b);
  ok("seats repack with no gaps", new Set(after).size === 7 && after[6] === 6, "(" + after + ")");
}

/* ---- 3. paddle movement ---- */
console.log("\npaddle movement");
{
  for (const n of [3, 5, 8]) {
    const m = fresh(n);
    const p = m.players.get(1);
    const start = p.t;
    setInput(m, 1, 1);
    run(m, 0.4);
    ok(n + "-gon: input moves the paddle", p.t > start + 0.1, "(" + p.t.toFixed(3) + ")");

    run(m, 5, (mm) => setInput(mm, 1, 1));
    const g = sideGeometry(m.sides, p.side);
    const pad = paddleAt(m, p);
    // The paddle must stay entirely on its own edge, never overhanging a vertex.
    const along = (pad.x - g.a.x) * g.dx + (pad.y - g.a.y) * g.dy;
    ok(n + "-gon: paddle stays on its own side",
      along - pad.half >= -1e-6 && along + pad.half <= g.len + 1e-6,
      "(" + (along - pad.half).toFixed(2) + ".." + (along + pad.half).toFixed(2) + " of " + g.len.toFixed(1) + ")");
    ok(n + "-gon: a pinned paddle reports zero velocity", Math.abs(p.vel) < 1e-9, "(" + p.vel + ")");
  }

  const m = fresh(4);
  setInput(m, 1, 5);          // out of range: the wire is not trusted
  step(m, DT);
  ok("input is clamped to -1..1", m.players.get(1).input === 1, "(" + m.players.get(1).input + ")");
}

/* ---- 4. damage tiers ---- */
console.log("\ndamage");
{
  ok("a fresh wall is green", damageColor(WALL_HP) === DAMAGE_COLORS[0], damageColor(WALL_HP));
  ok("one hit turns it yellow", damageColor(WALL_HP - 1) === DAMAGE_COLORS[1], damageColor(WALL_HP - 1));
  ok("two hits turn it red", damageColor(WALL_HP - 2) === DAMAGE_COLORS[2], damageColor(WALL_HP - 2));
  ok("a destroyed wall has no colour", damageColor(0) === null);
  ok("three hits is the whole bar", WALL_HP === 3);
}

/* ---- 5. serving ---- */
console.log("\nserving");
{
  const m = fresh(5);
  ok("a round opens on a serve", m.phase === "serve" && !m.ball.live);
  ok("the ball is parked centre", m.ball.x === CENTER && m.ball.y === CENTER);

  run(m, 2);
  ok("the serve becomes a rally", m.phase === "rally" && m.ball.live, "(" + m.phase + ")");
  const speed = Math.hypot(m.ball.vx, m.ball.vy);
  ok("the served ball is at exactly the start speed",
    Math.abs(speed - sim.BALL_SPEED_START) < 1e-9, "(" + speed.toFixed(4) + ")");

  // Determinism: the same seed must produce the same serve, or a replay proves nothing.
  const a = fresh(6, 99);
  const b = fresh(6, 99);
  run(a, 2);
  run(b, 2);
  ok("serves are deterministic for a seed", a.ball.vx === b.ball.vx && a.ball.vy === b.ball.vy);
}

/* ---- 6. rallies hold up at every player count ---- */
console.log("\nrallies");
/**
 * A tracking paddle has a finite speed, so it can legitimately be beaten by a shot placed far
 * enough along its edge — that is the game working, not a bug, and asserting "never concedes"
 * would be asserting the game is unloseable. What must hold at every player count is that
 * rallies are long and damage is rare: the ball stays in play, keeps finding paddles, and any
 * damage that does land is the occasional beaten tracker rather than a wall that cannot
 * defend itself.
 */
for (let n = 1; n <= MAX_PLAYERS; n++) {
  const m = fresh(n);
  let escaped = 0, worst = 0, paddleHits = 0, damage = 0;
  run(m, 25, autoDefend, (mm, events) => {
    for (const e of events) {
      if (e.type === "escape") escaped++;
      if (e.type === "paddle") paddleHits++;
      if (e.type === "hit") damage++;
    }
    const d = Math.hypot(mm.ball.x - CENTER, mm.ball.y - CENTER);
    if (d > worst) worst = d;
  });

  ok(n + " players: the ball never escapes", escaped === 0 && worst <= RADIUS + BALL_R * 4,
    "(escapes " + escaped + ", max r " + worst.toFixed(1) + ")");
  // 1-2 players share the wide rectangle, where two of the four walls are open scenery and
  // the court is deliberately short: the ball spends much of its time bouncing rather than
  // being returned, so the same bar as a full polygon would be measuring the shape, not the
  // defence.
  const wantReturns = n === 1 ? 5 : n === 2 ? 10 : 15;
  ok(n + " players: rallies sustain", paddleHits >= wantReturns,
    "(" + paddleHits + " returns in 25s, want " + wantReturns + ")");
  // Most approaches are returned; the rest are shots the tracker could not physically reach.
  // The rectangle concedes a little more often because an open top and bottom keep feeding
  // the ball back at a defended wall from angles a centred paddle has to travel to meet.
  const allowed = Math.max(2, paddleHits / (n <= 2 ? 5 : 12));
  ok(n + " players: tracking defence rarely concedes", damage <= allowed,
    "(" + damage + " conceded vs " + paddleHits + " returned)");
}

/* ---- 7. no tunnelling at max speed ---- */
console.log("\ntunnelling");
{
  const m = fresh(8);
  let maxSpeed = 0, escaped = 0;
  run(m, 60, autoDefend, (mm, events) => {
    for (const e of events) if (e.type === "escape") escaped++;
    maxSpeed = Math.max(maxSpeed, Math.hypot(mm.ball.vx, mm.ball.vy));
  });
  ok("the ball speed is capped", maxSpeed <= BALL_SPEED_MAX + 1e-6, "(" + maxSpeed.toFixed(1) + ")");
  // The real tunnelling assertion: at the speed cap the ball must never pass *through* a
  // paddle or a wall and end up loose outside the arena.
  ok("an octagon never leaks the ball at max speed", escaped === 0 && inside(m),
    "(escapes " + escaped + ")");
  ok("the ball is still in the arena", inside(m));
}

/* ---- 8. reflection angles ---- */
console.log("\nreflection");
{
  const m = fresh(6);
  let shallow = 0, wrongWay = 0, hits = 0;
  run(m, 40, autoDefend, (mm, events) => {
    for (const e of events) {
      if (e.type !== "paddle") continue;
      hits++;
      const g = sideGeometry(mm.sides, e.side);
      const speed = Math.hypot(mm.ball.vx, mm.ball.vy);
      const normal = (mm.ball.vx * g.nx + mm.ball.vy * g.ny) / speed;
      if (normal <= 0) wrongWay++;
      if (normal < 0.29) shallow++;
    }
  });
  ok("there were hits to check", hits > 10, "(" + hits + ")");
  ok("every return heads into the field", wrongWay === 0, "(" + wrongWay + " of " + hits + ")");
  ok("no return crawls along the wall", shallow === 0, "(" + shallow + " of " + hits + ")");
}

/* ---- 9. destruction shrinks the field ---- */
console.log("\ndestruction");
{
  // Player 1 defends; nobody else moves. Every other wall must fall, one at a time, and the
  // polygon must shrink by exactly one side each time.
  //
  // P1 tracks the ball but only within a limited reach of its resting position, so it plays
  // like a person rather than a solver. A *perfect* tracker is the wrong model here: two
  // flawless paddles on adjacent sides of a small polygon simply volley at each other
  // forever, and the match never resolves. Nothing in the sim prevents that and nothing
  // should — real thumbs are not perfect — but a test that drives one is testing an opponent
  // no player can be.
  const m = fresh(5);
  const shapes = [m.sides];
  let destroyed = 0;
  run(m, 900, (mm) => {
    for (const p of mm.players.values()) setInput(mm, p.id, 0);
    if (mm.phase !== "rally") return;
    const p = mm.players.get(1);
    if (!p || p.out) return;
    const g = sideGeometry(mm.sides, p.side);
    const along = ((mm.ball.x - g.a.x) * g.dx + (mm.ball.y - g.a.y) * g.dy) / g.len;
    const reach = Math.max(-0.28, Math.min(0.28, along - 0.5));
    setInput(mm, 1, Math.max(-1, Math.min(1, (0.5 + reach - p.t) * 12)));
  }, (mm, events) => {
    for (const e of events) {
      if (e.type === "destroyed") destroyed++;
      if (e.type === "reshape") shapes.push(e.sides);
    }
  });

  ok("walls are destroyed", destroyed >= 1, "(" + destroyed + ")");
  ok("the polygon shrinks one side per destruction",
    shapes.every((s, i) => i === 0 || s === shapes[i - 1] - 1 || s === 4),
    "(" + shapes.join(" -> ") + ")");
  ok("every destruction eliminated its player",
    [...m.players.values()].filter((p) => p.out).length === destroyed,
    "(" + destroyed + " destroyed, " + [...m.players.values()].filter((p) => p.out).length + " out)");
  ok("a destroyed player holds no side",
    [...m.players.values()].every((p) => !p.out || p.side === -1));
}
{
  // A match with nobody defending must terminate: every wall falls and one player is left.
  // This is the end-to-end guarantee that the shrink loop actually converges rather than
  // stalling on some polygon it cannot reduce further.
  for (const n of [3, 5, 8]) {
    const m = fresh(n, 3);
    run(m, 900, (mm) => {
      for (const p of mm.players.values()) setInput(mm, p.id, 0);
    });
    const alive = [...m.players.values()].filter((p) => !p.out);
    ok(n + " idle players: the match reaches a winner",
      m.phase === "over" && m.winner !== null && alive.length === 1,
      "(phase " + m.phase + ", winner " + m.winner + ", alive " + alive.length + ")");
    ok(n + " idle players: the arena shrank to a square or smaller",
      m.sides <= 4, "(" + m.sides + " sides)");
  }
}
{
  // A wall must take exactly WALL_HP hits, no more and no fewer.
  const m = fresh(3);
  const p2 = m.players.get(2);
  let hits = 0;
  run(m, 400, (mm) => {
    for (const p of mm.players.values()) if (p.id !== 2) {
      // Everyone but player 2 defends perfectly, so only player 2's wall can take damage.
      if (p.out) continue;
      const g = sideGeometry(mm.sides, p.side);
      const along = ((mm.ball.x - g.a.x) * g.dx + (mm.ball.y - g.a.y) * g.dy) / g.len;
      setInput(mm, p.id, Math.max(-1, Math.min(1, (along - p.t) * 12)));
    }
    setInput(mm, 2, 0);
  }, (mm, events) => {
    for (const e of events) if (e.type === "hit" && e.id === 2) hits++;
  });
  ok("a wall absorbs exactly " + WALL_HP + " hits before dying",
    p2.out && hits === WALL_HP, "(" + hits + " hits, out=" + p2.out + ")");
}

/* ---- 10. restart and disconnects ---- */
console.log("\nrestart and disconnects");
{
  const m = fresh(6);
  m.players.get(2).hp = 0;
  m.players.get(2).out = true;
  assignSeats(m);
  m.phase = "over";
  m.winner = 1;
  restart(m);
  const clean = [...m.players.values()].every((p) => p.hp === WALL_HP && !p.out);
  ok("restart heals every wall and reseats everyone",
    clean && m.winner === null && m.phase === "serve" && m.sides === 6, "(sides " + m.sides + ")");
}
{
  const m = fresh(7);
  run(m, 5, autoDefend);
  removePlayer(m, 3);
  run(m, 15, autoDefend);
  ok("the sim survives losing a player mid-rally", m.players.size === 6);
  ok("the polygon reshaped to the new roster", m.sides === 6, "(" + m.sides + ")");
  ok("the ball is still in the arena", inside(m));
}

/* ---- summary ---- */
console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
