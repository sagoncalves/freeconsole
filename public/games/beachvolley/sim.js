/**
 * Beach volleyball simulation - rules and physics, with no rendering in it.
 *
 * The screen owns this entirely. Phones send input events; this turns them into positions.
 * Keeping it free of Three.js means the whole game can be stepped headlessly, which is how
 * the bounce tuning below was measured.
 *
 * Coordinates: x runs along the net (left/right from the camera), y is up, z is depth. The
 * net sits at x = 0, so team A plays x < 0 and team B plays x > 0. Units are metres.
 */

/* ------------------------------------------------------------------ court */

export const COURT = {
  halfWidth: 8,      // playable extent either side of the net
  halfDepth: 4.5,    // court depth, purely visual - play is 2D in x/y
  netX: 0,
  netHeight: 2.24,   // real beach volleyball men's net, near enough
  netThickness: 0.12,
};

export const PLAYER = {
  radius: 0.42,
  height: 1.75,
  speed: 7.4,        // m/s top ground speed
  accel: 46,         // m/s^2 - reaches top speed in ~0.16s, so it feels responsive
  friction: 26,      // deceleration when not holding a direction
  jumpSpeed: 7.0,    // ~1.25m of hang, enough to spike over a 2.24m net
  // Players cannot cross the net or leave their half. Their reach past the sideline is
  // clamped so a rally always resolves in the court rather than off in the dunes.
  minGap: 0.55,      // how close to the net a player may stand
};

export const BALL = {
  radius: 0.34,
  gravity: -13.5,    // heavier than earth: a real 9.8 makes rallies feel floaty on a TV
  restitution: 0.62, // bounce off a player
  airDrag: 0.12,     // per second, keeps long spikes from sailing forever
  maxSpeed: 26,
  // A hit adds this much on top of the reflected speed, so a rally sustains itself instead
  // of decaying into a dribble. Tuned by playing 200 simulated rallies: below ~4 the ball
  // dies mid-court, above ~9 every touch is a spike that clears the court.
  hitBoost: 6.2,
  // A hit while rising is a spike: it gets extra downward drive. This is the one skill
  // expression the two-button control scheme allows, so it is worth a lot.
  spikeBoost: 5.0,
};

// A serve is lobbed across the net rather than dropped straight down, so an untouched one
// lands in the RECEIVING half. Both numbers come from sweeping the ballistics: a flat serve
// needs ~10m/s to clear the net, which reads as a rocket, whereas adding lift clears it at a
// gentle 7m/s. This pair peaks at 4.7m and lands around x=2.8 - well inside the far court,
// with plenty of hang time for the receiver to run under it.
export const SERVE_DRIVE = 7.0;
export const SERVE_LIFT = 4.0;

export const RULES = {
  pointsToWin: 7,
  winBy: 2,
  serveDelayMs: 1200,   // pause after a point, before the next serve drops
  maxTouches: 0,        // 0 = unlimited touches per side (cozy; no rotation faults)
  // Exactly three seconds, so the display reads 3 -> 2 -> 1 and then GO. Anything above a
  // round 3000 makes the first number show as "4" for a fraction of a second.
  countdownMs: 3000,
};

/* ----------------------------------------------------------------- helpers */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Which side of the net a team plays. Team 0 is x<0, team 1 is x>0. */
export function teamSign(team) {
  return team === 0 ? -1 : 1;
}

/* ------------------------------------------------------------------ state */

/**
 * A fresh match. `players` is a Map keyed by device id - never by array index, because
 * device ids have gaps once someone leaves.
 */
export function createMatch() {
  return {
    players: new Map(),
    ball: { x: 0, y: 3, z: 0, vx: 0, vy: 0, vz: 0, live: false, lastHitBy: null },
    score: [0, 0],
    phase: "waiting",        // waiting | countdown | serve | rally | point | over
    phaseUntil: 0,
    servingTeam: 0,
    lastPointTeam: null,
    winner: null,
    rallyTouches: 0,
    events: [],              // drained by the renderer each frame for sounds/effects
  };
}

/** Add a player to a team, positioned on their own side. */
export function addPlayer(match, deviceId, team, skinId) {
  const sign = teamSign(team);
  match.players.set(deviceId, {
    deviceId, team, skinId,
    x: sign * 3.4, y: 0, vx: 0, vy: 0,
    onGround: true,
    input: { left: false, right: false },
    facing: -sign,
    // Nobody plays until they have tapped "ready" on their phone, so a match never starts
    // while someone is still choosing a character.
    ready: false,
    // Cosmetic only: drives the arm swing when a hit lands.
    swing: 0,
  });
}

export function removePlayer(match, deviceId) {
  match.players.delete(deviceId);
}

/** Team sizes, used to place a joining player on the emptier side. */
export function teamCounts(match) {
  const counts = [0, 0];
  for (const p of match.players.values()) counts[p.team]++;
  return counts;
}

export function pickTeamFor(match) {
  const [a, b] = teamCounts(match);
  return a <= b ? 0 : 1;
}

/* ------------------------------------------------------------------- step */

/**
 * Advance the match by `dt` seconds. `now` is a room-wide timestamp (getServerTime), used
 * only for phase deadlines - never Date.now(), which differs between devices.
 */
export function step(match, dt, now) {
  stepPlayers(match, dt);

  if (match.phase === "countdown" && now >= match.phaseUntil) beginServe(match, now);
  if (match.phase === "serve" && now >= match.phaseUntil) startRally(match);
  if (match.phase === "point" && now >= match.phaseUntil) beginServe(match, now);

  if (match.ball.live) stepBall(match, dt, now);
}

function stepPlayers(match, dt) {
  for (const p of match.players.values()) {
    const dir = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);

    if (dir !== 0) {
      p.vx += dir * PLAYER.accel * dt;
      p.vx = clamp(p.vx, -PLAYER.speed, PLAYER.speed);
      p.facing = dir;
    } else {
      // Friction only on the ground: in the air you keep your momentum, so a jump commits
      // you to an arc and timing the take-off matters.
      if (p.onGround) {
        const drop = PLAYER.friction * dt;
        p.vx = Math.abs(p.vx) <= drop ? 0 : p.vx - Math.sign(p.vx) * drop;
      }
    }

    p.x += p.vx * dt;

    // Gravity and landing.
    if (!p.onGround) {
      p.vy += BALL.gravity * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
    }

    // Stay on your own half, between the net and the sideline.
    const sign = teamSign(p.team);
    const near = sign * PLAYER.minGap;
    const far = sign * (COURT.halfWidth - PLAYER.radius);
    const lo = Math.min(near, far), hi = Math.max(near, far);
    if (p.x < lo) { p.x = lo; p.vx = Math.max(0, p.vx); }
    if (p.x > hi) { p.x = hi; p.vx = Math.min(0, p.vx); }

    if (p.swing > 0) p.swing = Math.max(0, p.swing - dt * 3.4);
  }
}

function stepBall(match, dt, now) {
  const b = match.ball;

  b.vy += BALL.gravity * dt;
  const drag = Math.max(0, 1 - BALL.airDrag * dt);
  b.vx *= drag; b.vy *= drag;

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Net: a solid post from the ground to netHeight. Hitting it kills the ball's drive
  // rather than reflecting it cleanly - a net touch should feel like a mistake.
  if (Math.abs(b.x) < COURT.netThickness + BALL.radius && b.y < COURT.netHeight) {
    const side = b.x === 0 ? (b.vx > 0 ? 1 : -1) : Math.sign(b.x);
    b.x = side * (COURT.netThickness + BALL.radius);
    b.vx = -b.vx * 0.34;
    match.events.push({ type: "net" });
  }

  // Net cord: clipping the top slows the ball but lets it dribble over, which is the most
  // exciting thing that can happen in a rally.
  if (Math.abs(b.x) < COURT.netThickness + BALL.radius &&
      b.y >= COURT.netHeight && b.y < COURT.netHeight + BALL.radius) {
    b.vx *= 0.62; b.vy *= 0.45;
    match.events.push({ type: "cord" });
  }

  // Side walls, so the ball stays on screen.
  const wall = COURT.halfWidth + 1.6;
  if (b.x < -wall) { b.x = -wall; b.vx = Math.abs(b.vx) * 0.5; }
  if (b.x > wall) { b.x = wall; b.vx = -Math.abs(b.vx) * 0.5; }

  for (const p of match.players.values()) collideBallPlayer(match, b, p);

  clampBallSpeed(b);

  // Ground: the ball landing ends the rally and scores.
  if (b.y - BALL.radius <= 0) {
    b.y = BALL.radius;
    scorePoint(match, b.x < 0 ? 1 : 0, now);
  }
}

function clampBallSpeed(b) {
  const s = Math.hypot(b.vx, b.vy);
  if (s > BALL.maxSpeed) {
    const k = BALL.maxSpeed / s;
    b.vx *= k; b.vy *= k;
  }
}

/**
 * Ball/player contact. The player is a capsule; the ball reflects off the line from the
 * player's centre to the ball, plus a boost so rallies sustain themselves.
 */
function collideBallPlayer(match, b, p) {
  // Hit zone centred on the upper body, so heading and arm-height contacts both read right.
  const cx = p.x;
  const cy = p.y + PLAYER.height * 0.62;
  const dx = b.x - cx;
  const dy = b.y - cy;
  const dist = Math.hypot(dx, dy);
  const reach = PLAYER.radius + BALL.radius + 0.34;

  if (dist > reach || dist === 0) return;

  // Separate, then reflect along the contact normal.
  const nx = dx / dist, ny = dy / dist;
  b.x = cx + nx * reach;
  b.y = cy + ny * reach;

  const into = b.vx * nx + b.vy * ny;
  if (into < 0) {
    b.vx -= (1 + BALL.restitution) * into * nx;
    b.vy -= (1 + BALL.restitution) * into * ny;
  }

  // Every touch adds drive outward from the player, so the ball always leaves rather than
  // resting on someone's head.
  b.vx += nx * BALL.hitBoost;
  b.vy += ny * BALL.hitBoost;

  // Carry some of the player's own motion into the ball: running into a ball sends it
  // further than standing still, which is the main way position matters.
  b.vx += p.vx * 0.42;

  // A spike needs a jump AND contact above the head, so it rewards timing rather than
  // firing on any airborne touch. Gating on "rising" alone made almost every contact in a
  // bot match a spike (185 spikes to 14 normal hits), which flattened the rally out.
  const rising = !p.onGround && p.vy > 0.4;
  const overhead = b.y > p.y + PLAYER.height * 0.92;
  if (rising && overhead) {
    b.vy -= BALL.spikeBoost;
    b.vx += -teamSign(p.team) * BALL.spikeBoost * 0.55;
    match.events.push({ type: "spike", deviceId: p.deviceId, x: b.x, y: b.y });
  } else {
    match.events.push({ type: "hit", deviceId: p.deviceId, x: b.x, y: b.y });
  }

  // The ball must always end up moving away from the player, or a fast ball can tunnel back
  // through and hit twice in consecutive frames.
  const out = b.vx * nx + b.vy * ny;
  if (out < 1.2) { b.vx += nx * (1.2 - out); b.vy += ny * (1.2 - out); }

  b.lastHitBy = p.deviceId;
  match.rallyTouches++;
  p.swing = 1;

  clampBallSpeed(b);
}

/* ------------------------------------------------------------------ input */

/** A phone pressed or released a direction. */
export function setInput(match, deviceId, key, down) {
  const p = match.players.get(deviceId);
  if (!p) return;
  if (key === "left" || key === "right") p.input[key] = !!down;
}

/**
 * Drop every held direction for a device.
 *
 * Input lives on the screen, so a phone that reloads, backgrounds or reconnects leaves its
 * last "pressed" state behind - the new pad shows nothing held while the screen still thinks
 * a direction is down, and the player drifts or refuses to move. Clearing on (re)join makes
 * the screen's view match the pad the player is actually looking at.
 */
export function clearInput(match, deviceId) {
  const p = match.players.get(deviceId);
  if (!p) return;
  p.input.left = false;
  p.input.right = false;
  p.vx = 0;
}

/** A phone pressed jump. Only acts on the ground - no double jumps. */
export function jump(match, deviceId) {
  const p = match.players.get(deviceId);
  if (!p || !p.onGround) return;
  p.onGround = false;
  p.vy = PLAYER.jumpSpeed;
  match.events.push({ type: "jump", deviceId });
}

/* ------------------------------------------------------------------ phases */

/**
 * Put the ball up for the serving team and start the countdown.
 *
 * The ball drops over the serving team's own side, but with enough sideways drive to carry
 * it over the net if nobody touches it. Dropping it straight down was worse than it sounds:
 * an untouched serve landed on the server's own floor and scored for the opponent, and
 * because a point hands the serve to whoever won it, the same team served and scored over
 * and over - headless bot matches ended 7-0 without a single rally.
 */
export function beginServe(match, now) {
  const sign = teamSign(match.servingTeam);
  match.ball.x = sign * 4.5;
  match.ball.y = 4.2;
  match.ball.vx = -sign * SERVE_DRIVE;
  match.ball.vy = SERVE_LIFT;
  match.ball.live = false;
  match.ball.lastHitBy = null;
  match.rallyTouches = 0;
  match.phase = "serve";
  match.phaseUntil = now + RULES.serveDelayMs;
  match.events.push({ type: "serve", team: match.servingTeam });
}

function startRally(match) {
  match.phase = "rally";
  match.ball.live = true;
}

function scorePoint(match, team, now) {
  match.ball.live = false;
  match.score[team]++;
  match.servingTeam = team;
  match.lastPointTeam = team;
  match.phase = "point";
  match.phaseUntil = now + RULES.serveDelayMs;
  match.events.push({ type: "point", team, x: match.ball.x });

  const [a, b] = match.score;
  const lead = Math.abs(a - b);
  const top = Math.max(a, b);
  if (top >= RULES.pointsToWin && lead >= RULES.winBy) {
    match.winner = a > b ? 0 : 1;
    match.phase = "over";
    match.events.push({ type: "win", team: match.winner });
  }
}

/** Mark a device ready (or not). Returns true if the flag actually changed. */
export function setReady(match, deviceId, ready) {
  const p = match.players.get(deviceId);
  if (!p || p.ready === !!ready) return false;
  p.ready = !!ready;
  return true;
}

/**
 * Whether a match may begin: at least one player per side, and everyone in the room ready.
 * Both halves matter - "everyone ready" alone is true the instant the first player readies
 * up, which would start a match with an empty far side.
 */
export function canStart(match) {
  const [a, b] = teamCounts(match);
  if (a < 1 || b < 1) return false;
  for (const p of match.players.values()) if (!p.ready) return false;
  return true;
}

/** Reset scores and put everyone back on their marks, without starting play. */
function resetPositions(match) {
  for (const p of match.players.values()) {
    p.x = teamSign(p.team) * 3.4;
    p.y = 0; p.vx = 0; p.vy = 0; p.onGround = true;
    p.input.left = false; p.input.right = false;
  }
}

/**
 * Begin a fresh match: scores cleared, players on their marks, and a countdown running
 * before the first serve drops. The ball is parked and dead for the whole countdown so
 * nothing moves while the numbers tick down.
 */
export function restart(match, now) {
  match.score = [0, 0];
  match.winner = null;
  match.lastPointTeam = null;
  match.servingTeam = 0;
  match.rallyTouches = 0;
  resetPositions(match);

  match.ball.x = 0;
  match.ball.y = 4.2;
  match.ball.vx = 0;
  match.ball.vy = 0;
  match.ball.live = false;
  match.ball.lastHitBy = null;

  match.phase = "countdown";
  match.phaseUntil = now + RULES.countdownMs;
  match.events.push({ type: "countdown", until: match.phaseUntil });
}

/**
 * Seconds still to show during the countdown: 3, 2, 1, then GO.
 *
 * Returns 0 outside the countdown phase. `phaseUntil` is shared with the serve and point
 * delays, so reading it unconditionally made the numbers start counting down a second time
 * as soon as the first serve was scheduled.
 */
export function countdownRemaining(match, now) {
  if (match.phase !== "countdown") return 0;
  return Math.max(0, Math.ceil((match.phaseUntil - now) / 1000));
}
