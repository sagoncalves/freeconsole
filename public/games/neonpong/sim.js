/**
 * Neon Pong — deterministic 2D sim.
 *
 * Pong in the round, for up to eight players. Every player owns one side of a regular polygon
 * and defends it with a paddle that slides along that edge. Each side takes three hits —
 * green, yellow, red — and the fourth destroys it: the player is out and the polygon re-forms
 * with one fewer side, so the field literally shrinks as the match goes on. Last player
 * standing wins.
 *
 * Everything here is a pure function of (state, input, dt): the screen owns the only copy and
 * drives it from its own frame loop, controllers send paddle intent and nothing else. No
 * rigidbody physics — a ball with a velocity, oriented paddle segments, and hand-resolved
 * reflections against edge normals.
 *
 * The polygon is inscribed in a circle of radius FIELD/2 centred on (FIELD/2, FIELD/2). The
 * screen letterboxes that square; the sim never knows the pixel size.
 *
 * Geometry note: with fewer than three players there is no polygon to build, so 1- and
 * 2-player games run on a square with the unclaimed sides left open as plain bouncing walls.
 * That keeps two-player Neon Pong the classic head-to-head game it should be.
 */

/* ------------------------------------------------------------------- geometry */

/** The square the polygon is inscribed in. Also the circumscribed circle's diameter. */
export const FIELD = 1000;
export const CENTER = FIELD / 2;
/** Circumradius. Every vertex of every polygon sits exactly this far from the centre. */
export const RADIUS = FIELD / 2;

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;

/**
 * How many sides the arena has for a given number of live players.
 *
 * Three is the smallest real polygon, so 1 and 2 players fall back to a square with open
 * sides. From three up the side count tracks the player count exactly, which is the whole
 * point: your side is yours, and when it dies the arena gets smaller.
 */
export function sideCountFor(livePlayers) {
  return livePlayers >= 3 ? Math.min(MAX_PLAYERS, livePlayers) : 4;
}

/**
 * Vertices of a regular `n`-gon inscribed in the circle, in world space.
 *
 * The polygon is rotated so that side 0 faces left — with two players that puts the pair on
 * the left and right of a widescreen display, which is the orientation a TV actually has.
 * Every side, normal, and paddle position is derived from this one function, so the shape can
 * never disagree with itself.
 */
export function verticesFor(n) {
  const out = [];
  // Side i spans vertex i to vertex i+1. Offsetting by half a step puts the *centre* of side
  // 0 on the -x axis rather than a vertex, which is what makes side 0 a flat left wall.
  const base = Math.PI - Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = base + (i * 2 * Math.PI) / n;
    out.push({ x: CENTER + Math.cos(a) * RADIUS, y: CENTER + Math.sin(a) * RADIUS });
  }
  return out;
}

/**
 * The geometry of one side of an `n`-gon: endpoints, midpoint, unit direction along the edge,
 * inward unit normal, and length.
 *
 * `dir` runs from vertex i to vertex i+1 and is the axis a paddle slides along; `normal`
 * points at the centre. Reflections, goal tests and paddle boxes all read this, so a side is
 * described in exactly one place.
 */
export function sideGeometry(n, index) {
  const verts = verticesFor(n);
  const a = verts[index % n];
  const b = verts[(index + 1) % n];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey);
  const dx = ex / len;
  const dy = ey / len;
  // Both perpendiculars are candidates; pick the one pointing at the centre.
  let nx = -dy;
  let ny = dx;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((CENTER - mx) * nx + (CENTER - my) * ny < 0) { nx = -nx; ny = -ny; }
  return { a, b, mx, my, dx, dy, nx, ny, len };
}

/** Human-readable name for a side, used by the HUD and the controller. */
export function sideLabel(n, index) {
  if (n === 4) return ["Left", "Top", "Right", "Bottom"][index] || "Side " + (index + 1);
  return "Side " + (index + 1);
}

/* --------------------------------------------------------------------- tuning */

/**
 * Paddle length as a fraction of the side it sits on.
 *
 * Proportional rather than absolute: an octagon's sides are much shorter than a triangle's,
 * and a fixed length would either cover a whole octagon side or leave a triangle wide open.
 * This way every player defends the same share of their own edge no matter how many are
 * playing.
 */
const PADDLE_SPAN = 0.42;
export const PADDLE_THICK = 18;
/**
 * Gap between the wall and the paddle's outer face, measured inward.
 *
 * Deliberately small. On a polygon every paddle sits on a ring inside the wall, and the
 * deeper that ring is the further each paddle's ends poke across the approach path of the
 * *neighbouring* sides. Tuned for a square this was 24, which on a pentagon or an octagon put
 * the paddles so far in that a ball aimed at any gap was intercepted by a neighbour's tip
 * before it could reach a wall — rallies became endless corner ricochets and no side could
 * ever actually be hit. Keeping the paddle near its own wall keeps each player's reach on
 * their own edge, which is the whole premise of the shape.
 */
export const PADDLE_INSET = 6;
/** Paddle travel in edge-lengths per second, so every polygon plays at the same pace. */
const PADDLE_SPEED_FRAC = 0.95;

export const BALL_R = 13;

const BALL_SPEED_START = 430;
const BALL_SPEED_MAX = 1150;
/** Every paddle hit speeds the ball up by this factor, so a rally always resolves. */
const BALL_SPEEDUP = 1.045;

/**
 * How much of the paddle's own motion is dragged into the ball, and how far off-centre
 * contact bends it. Together these are the entire skill ceiling: a flat return is boring, so
 * both are generous enough that placement is a real decision.
 */
const SPIN_FROM_PADDLE = 0.32;
const SPIN_FROM_OFFSET = 0.85;

/**
 * The ball must never end up travelling nearly parallel to a wall — it turns into a long
 * un-hittable crawl along the paddle line. After every reflection the outgoing angle is
 * clamped so a minimum share of the speed is directed away from the wall.
 */
const MIN_NORMAL_SHARE = 0.30;

/**
 * Hits a side absorbs before it is destroyed.
 *
 * Three survivable mistakes, each with its own colour: green when fresh, yellow after one,
 * red after two. The fourth hit takes the side out entirely.
 */
export const WALL_HP = 3;

/** Damage tiers, worst-first lookup. The screen reads this so the colours cannot drift. */
export const DAMAGE_COLORS = ["#9dff4f", "#ffc247", "#ff2e88"];

/**
 * Colour for a side with `hp` remaining: green fresh, yellow at 2, red at 1.
 * Returns null for a destroyed side, which is drawn as a gap rather than a wall.
 */
export function damageColor(hp) {
  if (hp <= 0) return null;
  return DAMAGE_COLORS[Math.max(0, Math.min(DAMAGE_COLORS.length - 1, WALL_HP - hp))];
}

/** Seconds between a goal and the next serve, so the point is legible before play resumes. */
const T_SERVE = 1.15;

/** Seconds after a rally starts before the ball may score, so a serve is never instant death. */
const T_GRACE = 0.35;

/**
 * Longest a single rally may run before the ball is re-served.
 *
 * A polygon with paddles on every side can trap the ball in a closed orbit that never reaches
 * a wall: each paddle returns it perfectly into the next, and the cycle repeats forever. It
 * needs symmetric, near-static paddles, so live players rarely produce it — but "rarely" is
 * not "never", and a rally that cannot end is a match that cannot end. Re-serving breaks the
 * cycle without touching anyone's wall, so nobody is punished for the geometry.
 */
const T_RALLY_MAX = 30;

/* ---------------------------------------------------------------------- state */

/**
 * A match holds the roster, the ball, and the phase. Players are keyed by device id and never
 * by array position — ids have gaps, and every colour and score in the game is looked up by
 * id, so a seat map keyed by index would silently reassign everyone the moment someone drops.
 */
export function createMatch(seed) {
  return {
    players: new Map(),   // device id -> player
    ball: makeBall(),
    phase: "waiting",     // waiting | serve | rally | over
    winner: null,
    /** Current polygon side count. Recomputed whenever the live roster changes. */
    sides: 4,
    /** Countdown to the next serve, in seconds. Only meaningful in the "serve" phase. */
    serveIn: 0,
    /** Seconds the current rally has been live; the ball cannot score below T_GRACE. */
    rallyTime: 0,
    /** Rolling event log the screen drains each frame for effects and sound. */
    events: [],
    /** Consecutive paddle hits in this rally, for the screen's rally counter. */
    rally: 0,
    /** Deterministic RNG state, so a replayed match produces identical serves. */
    seed: (seed === undefined ? 12345 : seed) >>> 0,
    time: 0,
  };
}

function makeBall() {
  return { x: CENTER, y: CENTER, vx: 0, vy: 0, speed: BALL_SPEED_START, live: false };
}

/**
 * Deterministic RNG (mulberry32). The sim must never touch Math.random: the screen owns the
 * only copy today, but a headless test has to be able to replay a match exactly.
 */
function rand(match) {
  match.seed = (match.seed + 0x6d2b79f5) >>> 0;
  let t = match.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Seat a player. Returns the player, or null when the table is full.
 *
 * The seat index is assigned by `assignSeats`, which runs whenever the roster changes — a new
 * arrival changes the polygon for everyone, so seats can never be handed out independently.
 */
export function addPlayer(match, deviceId) {
  if (match.players.has(deviceId)) return match.players.get(deviceId);
  if (match.players.size >= MAX_PLAYERS) return null;

  const p = {
    id: deviceId,
    /** Which side of the polygon this player defends, 0..sides-1. */
    side: 0,
    /** Paddle centre along its side, 0..1 from vertex a to vertex b. */
    t: 0.5,
    /** Rate of change of `t`, carried into the ball as spin. */
    vel: 0,
    /** Stick deflection, -1..1, mirrored from the controller. */
    input: 0,
    /** Hits the side can still absorb. At zero the side is destroyed and the player is out. */
    hp: WALL_HP,
    out: false,
    hits: 0,
  };
  match.players.set(deviceId, p);
  assignSeats(match);
  return p;
}

export function removePlayer(match, deviceId) {
  match.players.delete(deviceId);
  assignSeats(match);
}

/**
 * Paddle intent: a single axis, -1..1. Clamped here rather than trusted, because it arrives
 * from a phone and nothing that crosses the wire gets to pick its own range.
 */
export function setInput(match, deviceId, value) {
  const p = match.players.get(deviceId);
  if (!p) return;
  const v = Number(value);
  p.input = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/** Clear held input, e.g. after a reconnect where the old session left the stick deflected. */
export function clearInput(match, deviceId) {
  const p = match.players.get(deviceId);
  if (p) p.input = 0;
}

/**
 * Re-seat everyone and resize the polygon to the live roster.
 *
 * This is the one place the arena's shape is decided. Seats go to live players in device-id
 * order so the seating is stable and predictable, and eliminated players are parked off the
 * polygon entirely — their side is gone, which is exactly what shrinks the field.
 */
export function assignSeats(match) {
  const live = [...match.players.values()].filter((p) => !p.out).sort((a, b) => a.id - b.id);
  match.sides = sideCountFor(live.length);
  live.forEach((p, i) => {
    // With 1-2 players on the fallback square, seat them on opposite sides so they face each
    // other rather than sharing a corner.
    p.side = live.length <= 2 ? i * 2 : i;
  });
  for (const p of match.players.values()) if (p.out) p.side = -1;
}

/** The live player defending side `index`, or undefined when that side is unclaimed. */
export function defenderOf(match, index) {
  for (const p of match.players.values()) {
    if (!p.out && p.side === index) return p;
  }
  return undefined;
}

/* ---------------------------------------------------------------- paddle geometry */

/** Half the paddle's length, in world units, on the current polygon. */
function paddleHalf(match) {
  return (sideGeometry(match.sides, 0).len * PADDLE_SPAN) / 2;
}

/**
 * The paddle's centre point and orientation on its side.
 *
 * Returns the centre in world space plus the side's own direction and inward normal, which is
 * everything both the collision test and the renderer need. `t` is clamped so the paddle
 * always stays fully on its own edge and never overhangs a vertex into a neighbour's side.
 */
export function paddleAt(match, p) {
  const g = sideGeometry(match.sides, p.side);
  const half = paddleHalf(match);
  // Fraction of the edge the paddle's half-length occupies, so clamping is in `t` units.
  const margin = half / g.len;
  const t = Math.max(margin, Math.min(1 - margin, p.t));
  // Sit the paddle inward from the wall by its inset plus half its thickness.
  const off = PADDLE_INSET + PADDLE_THICK / 2;
  const x = g.a.x + g.dx * (g.len * t) + g.nx * off;
  const y = g.a.y + g.dy * (g.len * t) + g.ny * off;
  return { x, y, half, g, t };
}

/** Backwards-compatible corner list for a paddle, for renderers that want a quad. */
export function paddleQuad(match, p) {
  const pad = paddleAt(match, p);
  const { g, half } = pad;
  const hx = g.dx * half;
  const hy = g.dy * half;
  const tx = g.nx * (PADDLE_THICK / 2);
  const ty = g.ny * (PADDLE_THICK / 2);
  return [
    { x: pad.x - hx - tx, y: pad.y - hy - ty },
    { x: pad.x + hx - tx, y: pad.y + hy - ty },
    { x: pad.x + hx + tx, y: pad.y + hy + ty },
    { x: pad.x - hx + tx, y: pad.y - hy + ty },
  ];
}

/* ----------------------------------------------------------------------- step */

/**
 * Advance the match by `dt` seconds.
 *
 * `dt` is clamped by the caller; nothing in here is frame-rate dependent, so a slow TV and a
 * fast one play the same game.
 */
export function step(match, dt) {
  match.time += dt;

  for (const p of match.players.values()) stepPaddle(match, p, dt);

  if (match.phase === "serve") {
    match.serveIn -= dt;
    if (match.serveIn <= 0) beginRally(match);
    return;
  }
  if (match.phase !== "rally") return;

  match.rallyTime += dt;
  stepBall(match, dt);
  checkEscape(match);

  // Break a rally that has become a closed orbit. Harmless when play is normal: 30 seconds is
  // far longer than any real exchange.
  if (match.phase === "rally" && match.rallyTime >= T_RALLY_MAX) {
    match.events.push({ type: "stalemate" });
    queueServe(match);
  }
}

/**
 * Recover a ball that has left the arena.
 *
 * The polygon re-forms the instant a side is destroyed, and the ball is very often outside
 * the new, smaller shape when that happens — it was on its way to a wall that no longer
 * exists. Rather than let it sail away forever, anything found beyond the circumradius is
 * re-served. Without this the match silently stops: the ball is gone, no side can ever be
 * hit, and the round never ends.
 */
function checkEscape(match) {
  const b = match.ball;
  if (Math.hypot(b.x - CENTER, b.y - CENTER) <= RADIUS + BALL_R * 4) return;
  match.events.push({ type: "escape", x: b.x, y: b.y });
  queueServe(match);
}

function stepPaddle(match, p, dt) {
  if (p.out) return;
  const g = sideGeometry(match.sides, p.side);
  const margin = paddleHalf(match) / g.len;
  const prev = p.t;
  // Speed is in edge-fractions per second, so a short octagon side is crossed as quickly as a
  // long triangle one and no seat feels sluggish.
  p.t = Math.max(margin, Math.min(1 - margin, p.t + p.input * PADDLE_SPEED_FRAC * dt));
  // Measured rather than assumed: a paddle pinned against its travel limit has zero velocity
  // and must not keep imparting spin as though it were still moving.
  p.vel = dt > 0 ? (p.t - prev) / dt : 0;
}

/**
 * Move the ball and resolve one frame of contacts.
 *
 * Substepped so a fast ball cannot tunnel through a paddle: at BALL_SPEED_MAX the ball covers
 * ~19px per 60Hz frame, which is close enough to the paddle thickness that a single sweep
 * would eventually miss one. The step count is derived from the distance actually travelled,
 * so a slow rally costs nothing.
 */
function stepBall(match, dt) {
  const dist = Math.hypot(match.ball.vx, match.ball.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / (PADDLE_THICK * 0.5)));
  const sub = dt / steps;
  for (let i = 0; i < steps && match.phase === "rally"; i++) subStepBall(match, sub);
}

function subStepBall(match, dt) {
  const b = match.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  for (const p of match.players.values()) {
    if (p.out) continue;
    tryPaddle(match, p);
  }

  resolveSides(match);
}

/**
 * Reflect the ball off one paddle, if it is touching and heading into it.
 *
 * Worked in the paddle's own frame: distance along the edge and distance along the inward
 * normal. That reduces an arbitrarily-rotated paddle to the same box test the square version
 * used, so the maths stays simple no matter how many sides the arena has.
 */
function tryPaddle(match, p) {
  const b = match.ball;
  const pad = paddleAt(match, p);
  const g = pad.g;

  const rx = b.x - pad.x;
  const ry = b.y - pad.y;
  const along = rx * g.dx + ry * g.dy;        // along the edge, 0 at the paddle's centre
  const into = rx * g.nx + ry * g.ny;         // toward the field centre

  const halfT = PADDLE_THICK / 2;
  // Nearest point on the paddle rectangle, in the same local frame.
  const ca = Math.max(-pad.half, Math.min(along, pad.half));
  const ct = Math.max(-halfT, Math.min(into, halfT));
  const da = along - ca;
  const dt2 = into - ct;
  if (da * da + dt2 * dt2 > BALL_R * BALL_R) return;

  // Only reflect a ball still travelling into the paddle. Without this a ball that clips the
  // end gets reflected on two consecutive frames and ends up going back through the paddle.
  const vn = b.vx * g.nx + b.vy * g.ny;       // positive = moving toward the centre
  if (vn >= 0) return;

  // Where along the paddle it landed, -1..1. This is the placement control: hitting with the
  // end of the paddle throws the ball out at an angle.
  const offset = Math.max(-1, Math.min(1, along / pad.half));

  reflect(match, p, pad, offset);
  p.hits++;
  match.rally++;
  match.events.push({ type: "paddle", id: p.id, x: b.x, y: b.y, side: p.side, offset });
}

/**
 * Turn a contact into an outgoing velocity.
 *
 * The normal component is rebuilt pointing into the field and the tangential component comes
 * from the contact offset and the paddle's own motion. Rebuilding rather than adjusting keeps
 * the shot predictable — the same contact always produces the same return, regardless of how
 * the ball happened to arrive.
 */
function reflect(match, p, pad, offset) {
  const b = match.ball;
  const g = pad.g;
  const speed = Math.min(BALL_SPEED_MAX, b.speed * BALL_SPEEDUP);
  b.speed = speed;

  let tangent = offset * SPIN_FROM_OFFSET + (p.vel / PADDLE_SPEED_FRAC) * SPIN_FROM_PADDLE;
  const maxTangent = Math.sqrt(1 - MIN_NORMAL_SHARE * MIN_NORMAL_SHARE);
  tangent = Math.max(-maxTangent, Math.min(maxTangent, tangent));
  const normal = Math.sqrt(Math.max(0, 1 - tangent * tangent));

  // Recompose in world space: `normal` along the inward normal, `tangent` along the edge.
  b.vx = (g.nx * normal + g.dx * tangent) * speed;
  b.vy = (g.ny * normal + g.dy * tangent) * speed;

  // Push clear of the paddle so the next frame cannot re-trigger the same contact.
  const clear = PADDLE_THICK / 2 + BALL_R + 0.5;
  b.x = pad.x + g.dx * (offset * pad.half) + g.nx * clear;
  b.y = pad.y + g.dy * (offset * pad.half) + g.ny * clear;
}

/**
 * Handle the ball reaching the polygon's boundary.
 *
 * A defended side takes damage; an unclaimed one just bounces. A destroyed side is a genuine
 * gap — the ball passes straight through it and out of the arena, which is caught by the
 * escape test below rather than here.
 */
function resolveSides(match) {
  const b = match.ball;
  const n = match.sides;

  for (let i = 0; i < n; i++) {
    const g = sideGeometry(n, i);
    // Signed distance from the wall plane, positive on the inside.
    const depth = (b.x - g.mx) * g.nx + (b.y - g.my) * g.ny;
    if (depth > BALL_R) continue;

    // Only the stretch of wall this side actually spans; beyond a vertex is a neighbour's
    // problem, and testing the infinite plane would bounce the ball off walls it is nowhere
    // near on a polygon with many sides.
    const along = (b.x - g.a.x) * g.dx + (b.y - g.a.y) * g.dy;
    if (along < -BALL_R || along > g.len + BALL_R) continue;

    const keeper = defenderOf(match, i);

    if (keeper && match.rallyTime >= T_GRACE) {
      damageSide(match, keeper, b.x, b.y);
      return;
    }
    // Serve grace, or an unclaimed side: bounce rather than score, so nobody loses a wall to
    // the serve itself and an open side stays a plain bouncy edge.
    bounceOffSide(b, g);
  }
}

function bounceOffSide(b, g) {
  const vn = b.vx * g.nx + b.vy * g.ny;
  if (vn < 0) {
    // Reflect the normal component back into the field.
    b.vx -= 2 * vn * g.nx;
    b.vy -= 2 * vn * g.ny;
  }
  // Lift clear of the wall so the next frame cannot re-trigger the same contact.
  const depth = (b.x - g.mx) * g.nx + (b.y - g.my) * g.ny;
  const push = BALL_R + 0.5 - depth;
  if (push > 0) { b.x += g.nx * push; b.y += g.ny * push; }
}

/* ---------------------------------------------------------------------- scoring */

/**
 * A hit on a defended side. Three of them turn it green -> yellow -> red; the fourth destroys
 * the side, eliminates the player, and shrinks the arena.
 */
function damageSide(match, p, x, y) {
  p.hp = Math.max(0, p.hp - 1);
  match.ball.live = false;
  match.events.push({ type: "hit", id: p.id, side: p.side, hp: p.hp, x, y });

  if (p.hp === 0) {
    p.out = true;
    match.events.push({ type: "destroyed", id: p.id, side: p.side, x, y });
    // Re-form the polygon around whoever is left. This is the moment the field shrinks.
    assignSeats(match);
    match.events.push({ type: "reshape", sides: match.sides });
  }

  const alive = [...match.players.values()].filter((q) => !q.out);
  // One player left standing ends it. With a single player at the table there is nobody to
  // outlast, so running out of wall is simply the end of the run.
  if (alive.length <= 1 && match.players.size > 1) {
    finish(match, alive[0] ? alive[0].id : null);
    return;
  }
  if (alive.length === 0) {
    finish(match, null);
    return;
  }
  queueServe(match);
}

function finish(match, winnerId) {
  match.phase = "over";
  match.winner = winnerId;
  match.ball.live = false;
  match.events.push({ type: "win", id: winnerId });
}

/* ----------------------------------------------------------------------- serves */

/** Park the ball in the middle and start the countdown to the next rally. */
export function queueServe(match) {
  match.phase = "serve";
  match.serveIn = T_SERVE;
  match.rally = 0;
  const b = match.ball;
  b.x = CENTER;
  b.y = CENTER;
  b.vx = 0;
  b.vy = 0;
  b.live = false;
  b.speed = BALL_SPEED_START;
  match.events.push({ type: "serve" });
}

/**
 * Launch the ball toward a random live player.
 *
 * Aiming at a player rather than in a random direction means every serve immediately belongs
 * to someone: nobody watches the ball drift into an open side and wonder whose point it was.
 */
function beginRally(match) {
  const alive = [...match.players.values()].filter((p) => !p.out);
  if (alive.length === 0) return;

  const target = alive[Math.floor(rand(match) * alive.length) % alive.length];
  const g = sideGeometry(match.sides, target.side);

  // Aim at a point on the target's side, offset along it so the serve is not always dead
  // centre. Kept well inside the vertices so the opening shot is always genuinely theirs.
  const spread = (rand(match) - 0.5) * 0.5;
  const aimX = g.mx + g.dx * (g.len * spread);
  const aimY = g.my + g.dy * (g.len * spread);

  const b = match.ball;
  const mag = Math.hypot(aimX - CENTER, aimY - CENTER) || 1;
  b.speed = BALL_SPEED_START;
  b.vx = ((aimX - CENTER) / mag) * b.speed;
  b.vy = ((aimY - CENTER) / mag) * b.speed;

  b.live = true;
  match.phase = "rally";
  match.rallyTime = 0;
  match.events.push({ type: "rally", id: target.id });
}

/* ---------------------------------------------------------------------- rounds */

/** Start or restart a match with the current roster. */
export function restart(match) {
  match.winner = null;
  match.rally = 0;
  for (const p of match.players.values()) {
    p.hp = WALL_HP;
    p.out = false;
    p.t = 0.5;
    p.vel = 0;
    p.input = 0;
    p.hits = 0;
  }
  assignSeats(match);
  match.events.push({ type: "start" });
  queueServe(match);
}

export {
  T_SERVE, T_GRACE, BALL_SPEED_START, BALL_SPEED_MAX, PADDLE_SPAN, PADDLE_SPEED_FRAC,
};
