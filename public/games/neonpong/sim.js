/**
 * Neon Pong — deterministic 2D sim.
 *
 * Pong for up to four players on the four walls of a square. Everything here is a pure
 * function of (state, input, dt): the screen owns the only copy and drives it from its own
 * frame loop, controllers send paddle intent and nothing else. No rigidbody physics — a ball
 * with a velocity, axis-aligned paddles, and hand-resolved reflections.
 *
 * Play space is a fixed FIELD x FIELD square in world units. The screen letterboxes it; the
 * sim never knows the pixel size.
 *
 * Scoring is subtractive: everyone starts with the same number of lives and loses one when
 * the ball passes their own wall. The last player alive wins. That is the whole damage model
 * — there is no health and nothing else can eliminate you.
 */

/* ------------------------------------------------------------------- geometry */

/** The playfield is a square; every wall is the same length, so no seat has an easier job. */
export const FIELD = 1000;

/** Wall indices. Order matters: it is also the seating order as players join. */
export const BOTTOM = 0;
export const TOP = 1;
export const LEFT = 2;
export const RIGHT = 3;

/**
 * Which axis a wall's paddle slides along, and which way its inward normal points.
 *
 * `axis` is "x" for the horizontal walls and "y" for the vertical ones — the coordinate the
 * paddle moves in. `normal` is +1 when the wall is at the low end of the perpendicular axis
 * and the field lies in the positive direction, -1 otherwise. Every reflection, every goal
 * test, and every paddle box is derived from this table rather than from four copies of
 * nearly-identical code, so a wall can never disagree with itself.
 */
export const WALLS = {
  [BOTTOM]: { axis: "x", perp: "y", at: FIELD, normal: -1, label: "Bottom" },
  [TOP]:    { axis: "x", perp: "y", at: 0,     normal: 1,  label: "Top" },
  [LEFT]:   { axis: "y", perp: "x", at: 0,     normal: 1,  label: "Left" },
  [RIGHT]:  { axis: "y", perp: "x", at: FIELD, normal: -1, label: "Right" },
};

/** Seats fill in this order, so two players always face each other across the field. */
export const SEAT_ORDER = [BOTTOM, TOP, LEFT, RIGHT];

/* --------------------------------------------------------------------- tuning */

export const PADDLE_LEN = 190;      // along the wall
export const PADDLE_THICK = 18;     // into the field
export const PADDLE_INSET = 26;     // gap between the wall and the paddle's outer face
const PADDLE_SPEED = 900;           // px/s at full stick deflection

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

const LIVES_START = 3;

/** Seconds between a goal and the next serve, so the point is legible before play resumes. */
const T_SERVE = 1.15;

/** Seconds after a rally starts before the ball may score, so a serve is never instant death. */
const T_GRACE = 0.35;

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
  return { x: FIELD / 2, y: FIELD / 2, vx: 0, vy: 0, speed: BALL_SPEED_START, live: false };
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
 * Seat a player at the next free wall.
 *
 * Seats are handed out in SEAT_ORDER rather than by join order alone, so the second player
 * always lands opposite the first and a two-player game is classic head-to-head Pong. Returns
 * the player, or null when the table is full.
 */
export function addPlayer(match, deviceId) {
  if (match.players.has(deviceId)) return match.players.get(deviceId);
  const taken = new Set([...match.players.values()].map((p) => p.wall));
  const wall = SEAT_ORDER.find((w) => !taken.has(w));
  if (wall === undefined) return null;

  const p = {
    id: deviceId,
    wall,
    /** Paddle centre along the wall's axis, in world units. */
    pos: FIELD / 2,
    /** Velocity along the wall, carried into the ball as spin. */
    vel: 0,
    /** Stick deflection, -1..1, mirrored from the controller. */
    input: 0,
    lives: LIVES_START,
    out: false,
    hits: 0,
  };
  match.players.set(deviceId, p);
  return p;
}

export function removePlayer(match, deviceId) {
  match.players.delete(deviceId);
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

/* ---------------------------------------------------------------- paddle geometry */

/**
 * Half the travel available to a paddle centre. The paddle stays fully inside the field, so
 * the corners are always covered by whichever paddle owns that stretch of wall.
 */
function halfTravel() {
  return FIELD / 2 - PADDLE_LEN / 2;
}

/**
 * The paddle's box in world space: { x, y, w, h }.
 *
 * Derived from the wall table, so the horizontal and vertical walls cannot drift apart. The
 * box is the collision surface and the thing the screen draws, which is what keeps the
 * drawing honest about what will actually be hit.
 */
export function paddleBox(p) {
  const w = WALLS[p.wall];
  const half = PADDLE_LEN / 2;
  // Distance from the wall plane to the paddle's inner face, measured into the field.
  const near = PADDLE_INSET;
  if (w.axis === "x") {
    const y = w.normal > 0 ? w.at + near : w.at - near - PADDLE_THICK;
    return { x: p.pos - half, y, w: PADDLE_LEN, h: PADDLE_THICK };
  }
  const x = w.normal > 0 ? w.at + near : w.at - near - PADDLE_THICK;
  return { x, y: p.pos - half, w: PADDLE_THICK, h: PADDLE_LEN };
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

  for (const p of match.players.values()) stepPaddle(p, dt);

  if (match.phase === "serve") {
    match.serveIn -= dt;
    if (match.serveIn <= 0) beginRally(match);
    return;
  }
  if (match.phase !== "rally") return;

  match.rallyTime += dt;
  stepBall(match, dt);
}

function stepPaddle(p, dt) {
  if (p.out) return;
  const limit = halfTravel();
  const prev = p.pos;
  p.pos = Math.max(FIELD / 2 - limit, Math.min(FIELD / 2 + limit, p.pos + p.input * PADDLE_SPEED * dt));
  // Measured rather than assumed: a paddle pinned against its travel limit has zero velocity
  // and must not keep imparting spin as though it were still moving.
  p.vel = dt > 0 ? (p.pos - prev) / dt : 0;
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

  resolveWalls(match);
}

/**
 * Reflect the ball off one paddle, if it is touching and heading into it.
 *
 * The direction test matters as much as the overlap: without it a ball that clips the end of
 * a paddle gets reflected on two consecutive frames and ends up travelling back through the
 * paddle it just bounced off.
 */
function tryPaddle(match, p) {
  const b = match.ball;
  const w = WALLS[p.wall];
  const box = paddleBox(p);

  // Circle vs axis-aligned box, done as a distance to the nearest point on the box.
  const nx = Math.max(box.x, Math.min(b.x, box.x + box.w));
  const ny = Math.max(box.y, Math.min(b.y, box.y + box.h));
  const dx = b.x - nx;
  const dy = b.y - ny;
  if (dx * dx + dy * dy > BALL_R * BALL_R) return;

  // Velocity component along the wall's inward normal. Positive means it is still moving
  // deeper into the paddle, which is the only case worth reflecting.
  const inward = w.perp === "y" ? b.vy : b.vx;
  if (inward * -w.normal <= 0) return;

  // Where on the paddle it landed, -1 at one end and 1 at the other. This is the placement
  // control: hitting with the end of the paddle throws the ball out at an angle.
  const along = w.axis === "x" ? b.x : b.y;
  const offset = Math.max(-1, Math.min(1, (along - p.pos) / (PADDLE_LEN / 2)));

  reflect(match, p, offset);
  p.hits++;
  match.rally++;
  match.events.push({ type: "paddle", id: p.id, x: b.x, y: b.y, wall: p.wall, offset });
}

/**
 * Turn a contact into an outgoing velocity.
 *
 * The normal component is simply flipped; the tangential component is rebuilt from the
 * contact offset and the paddle's own motion. Rebuilding rather than adjusting is what keeps
 * the shot predictable — the same contact always produces the same return, regardless of how
 * the ball happened to arrive.
 */
function reflect(match, p, offset) {
  const b = match.ball;
  const w = WALLS[p.wall];
  const speed = Math.min(BALL_SPEED_MAX, b.speed * BALL_SPEEDUP);
  b.speed = speed;

  // Tangential share, then whatever is left goes into the normal.
  let tangent = offset * SPIN_FROM_OFFSET + (p.vel / PADDLE_SPEED) * SPIN_FROM_PADDLE;
  const maxTangent = Math.sqrt(1 - MIN_NORMAL_SHARE * MIN_NORMAL_SHARE);
  tangent = Math.max(-maxTangent, Math.min(maxTangent, tangent));
  const normal = Math.sqrt(Math.max(0, 1 - tangent * tangent)) * w.normal;

  if (w.axis === "x") { b.vx = tangent * speed; b.vy = normal * speed; }
  else { b.vy = tangent * speed; b.vx = normal * speed; }

  // Push clear of the paddle so the next frame cannot re-trigger the same contact.
  const box = paddleBox(p);
  if (w.perp === "y") b.y = w.normal > 0 ? box.y + box.h + BALL_R + 0.5 : box.y - BALL_R - 0.5;
  else b.x = w.normal > 0 ? box.x + box.w + BALL_R + 0.5 : box.x - BALL_R - 0.5;
}

/**
 * Handle the ball reaching a wall: a goal against whoever is defending it, or a plain bounce
 * where the wall is unmanned.
 *
 * An empty wall bouncing is what makes 2- and 3-player games work at all — with two players
 * the left and right walls are simply the sides of a classic Pong table.
 */
function resolveWalls(match) {
  const b = match.ball;
  for (const wall of SEAT_ORDER) {
    const w = WALLS[wall];
    const coord = w.perp === "y" ? b.y : b.x;
    // Past the wall plane, measured inward-negative: >0 means it has crossed.
    const past = w.normal > 0 ? -(coord - w.at) : coord - w.at;
    if (past < -BALL_R) continue;

    const keeper = defenderOf(match, wall);
    if (keeper && match.rallyTime >= T_GRACE) {
      concede(match, keeper);
      return;
    }
    if (keeper && match.rallyTime < T_GRACE) {
      // Serve grace: a ball that somehow reaches a wall in the first moments is bounced
      // rather than scored, so nobody loses a life to the serve itself.
      bounceOffWall(b, w);
      continue;
    }
    bounceOffWall(b, w);
  }
}

function bounceOffWall(b, w) {
  if (w.perp === "y") {
    b.y = w.at + w.normal * (BALL_R + 0.5);
    b.vy = Math.abs(b.vy) * w.normal;
  } else {
    b.x = w.at + w.normal * (BALL_R + 0.5);
    b.vx = Math.abs(b.vx) * w.normal;
  }
}

/** The live player defending a wall, or undefined when that wall is open. */
function defenderOf(match, wall) {
  for (const p of match.players.values()) {
    if (p.wall === wall && !p.out) return p;
  }
  return undefined;
}

/* ---------------------------------------------------------------------- scoring */

function concede(match, p) {
  p.lives = Math.max(0, p.lives - 1);
  match.ball.live = false;
  match.events.push({ type: "goal", id: p.id, wall: p.wall, x: match.ball.x, y: match.ball.y });

  if (p.lives === 0) {
    p.out = true;
    match.events.push({ type: "eliminated", id: p.id, wall: p.wall });
  }

  const alive = [...match.players.values()].filter((q) => !q.out);
  // One player left standing ends it. With a single player at the table there is nobody to
  // outlast, so running out of lives is simply the end of the run.
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
  b.x = FIELD / 2;
  b.y = FIELD / 2;
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
 * to someone: nobody watches the ball drift into an empty wall and wonder whose point it was.
 */
function beginRally(match) {
  const alive = [...match.players.values()].filter((p) => !p.out);
  if (alive.length === 0) return;

  const target = alive[Math.floor(rand(match) * alive.length) % alive.length];
  const w = WALLS[target.wall];

  // Aim at the target's wall, offset along it so the serve is not always dead centre.
  const spread = (rand(match) - 0.5) * 0.7;
  const b = match.ball;
  b.speed = BALL_SPEED_START;
  if (w.axis === "x") { b.vx = spread * b.speed; b.vy = -w.normal * b.speed; }
  else { b.vy = spread * b.speed; b.vx = -w.normal * b.speed; }

  // Renormalise: the spread above lengthens the vector, and the ball's speed is the one thing
  // the rest of the sim assumes is exactly `speed`.
  const mag = Math.hypot(b.vx, b.vy) || 1;
  b.vx = (b.vx / mag) * b.speed;
  b.vy = (b.vy / mag) * b.speed;

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
    p.lives = LIVES_START;
    p.out = false;
    p.pos = FIELD / 2;
    p.vel = 0;
    p.input = 0;
    p.hits = 0;
  }
  match.events.push({ type: "start" });
  queueServe(match);
}

/**
 * Re-seat everyone so seats stay packed after a disconnect.
 *
 * Called whenever the roster changes. Lower device ids take earlier seats, which makes the
 * seating stable and predictable: the same room always sits down the same way.
 */
export function assignSeats(match) {
  const ids = [...match.players.keys()].sort((a, b) => a - b);
  ids.forEach((id, i) => {
    const p = match.players.get(id);
    if (p) p.wall = SEAT_ORDER[i % SEAT_ORDER.length];
  });
}

export { LIVES_START, T_SERVE, BALL_SPEED_START, BALL_SPEED_MAX, PADDLE_SPEED };
