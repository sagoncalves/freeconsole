/**
 * Deterministic fencing sim.
 *
 * Everything here is a pure function of (state, input, dt). The screen owns the only copy and
 * drives it from its own frame loop; controllers send intent only. There is no rigidbody
 * physics and no animation blending - a character controller with hand-resolved box
 * collisions, and states that switch on the frame they are asked to (spec 6, 28, 31).
 *
 * Nothing in here has health. Every lethal interaction sets `dead` and that is the whole
 * damage model (spec 12).
 */

import {
  SCREEN_W, SCREEN_H, GROUND_Y, KILL_Y, MIN_SCREEN, MAX_SCREEN,
  GOAL_LEFT, GOAL_RIGHT, screenAt, screenLeft, buildSolids, buildSpawnPoints,
} from "/games/nidhogg/arena.js?v=1";

/* ------------------------------------------------------------------- tuning */

// Movement. Tuned so a screen takes roughly two seconds to cross at a run: fast enough that
// winning a duel feels like it bought real ground, slow enough that the defender can contest.
const RUN_SPEED = 300;
const WALK_SPEED = 165;
const ACCEL = 2600;          // ground acceleration toward target speed
const AIR_ACCEL = 900;       // spec 7: air control exists but is limited
const FRICTION = 2400;
const GRAVITY = 1900;
const JUMP_VELOCITY = -640;  // fixed height, no double jump (spec 7)
const MAX_FALL = 1250;

// Wall interaction (spec 23). Mobility only - none of it is a combat tool.
const WALL_SLIDE_SPEED = 190;
const WALL_JUMP_X = 330;
const WALL_JUMP_Y = -580;
const WALL_CLIMB_SPEED = 170;
const WALL_CLIMB_MAX = 0.42;   // seconds of climb before the grip gives out

// Body boxes. Ducking and crawling shrink the hurtbox, which is the entire point of them:
// a low guard sails over a crawling player.
const BODY_W = 26;
const BODY_H = 68;
const DUCK_H = 42;
const CRAWL_H = 26;

// Sword geometry. Reach is deliberately long relative to the body so spacing is the game.
const SWORD_REACH = 46;
const SWORD_THICK = 10;
const LUNGE_REACH = 78;

// Timings, in seconds. Short and readable - large anticipation, immediate resolution.
const T_LUNGE = 0.30;
const T_LUNGE_RECOVER = 0.26;   // spec 18: high commitment, punished if it misses
const T_THRUST = 0.16;
const T_THRUST_RECOVER = 0.10;
const T_PUNCH = 0.16;
const T_KICK = 0.24;
const T_DIVE = 0.55;
const T_KNOCKDOWN = 0.85;
const T_ROLL = 0.42;
const T_RESPAWN = 1.0;          // spec 5: ~1 second
const T_LAND_RECOVER = 0.07;    // spec 7: a few recovery frames

// Combat geometry.
const NECK_SNAP_RANGE = 34;
const PUNCH_RANGE = 34;
const KICK_RANGE = 40;
const PUNCH_SHOVE = 260;
const THROW_SPEED = 720;
const THROW_SPIN = 15;

/** Sword guard heights (spec 9). Index order matters: adjacent heights are what clash. */
export const HIGH = 0;
export const MID = 1;
export const LOW = 2;

/** Vertical offset of the blade from the body's top edge, per guard height. */
const GUARD_Y = { 0: 12, 1: 30, 2: 50 };

/* -------------------------------------------------------------------- state */

const solids = buildSolids();
const spawnPoints = buildSpawnPoints();

export function createMatch() {
  return {
    players: new Map(),     // device id -> player. Keyed by id, never by array position.
    /** Loose swords lying on the ground or in flight (spec 15, 16). */
    swords: [],
    /** Active screen index. The camera shows exactly this one (spec 25). */
    screen: 0,
    /** Screen the camera is easing toward; equal to `screen` when settled. */
    cameraScreen: 0,
    cameraX: screenLeft(0),
    phase: "waiting",       // waiting | fight | over
    winner: null,
    /** Rolling event log the screen drains each frame for effects and sound. */
    events: [],
    time: 0,
    /** Frame counter, so effects can be seeded deterministically. */
    frame: 0,
  };
}

/**
 * Seat a player. `side` is 0 for the left team (advances right) or 1 for the right team.
 * A player's side never changes - the map is symmetric and both players are identical
 * in every respect (spec 35).
 */
export function addPlayer(match, deviceId, side) {
  const facing = side === 0 ? 1 : -1;
  const start = startPointFor(side);
  const p = {
    id: deviceId,
    side,
    x: start.x - BODY_W / 2,
    y: start.y - BODY_H,
    vx: 0,
    vy: 0,
    facing,
    state: "idle",
    /** Time remaining in a committed action. Zero means free to act. */
    timer: 0,
    /** The action that owns `timer`, so we know what to resolve when it expires. */
    action: null,
    armed: true,
    guard: MID,
    onGround: false,
    wallDir: 0,          // -1 touching a wall on the left, 1 on the right, 0 free
    climbTime: 0,
    dead: false,
    respawnAt: 0,
    /** Set while a lethal box is live, so a trade resolves the same way both directions. */
    lethal: false,
    height: BODY_H,
    input: freshInput(),
    /** Consumed one-shot intents, latched until the sim reads them. */
    pressed: {},
    kills: 0,
    deaths: 0,
  };
  match.players.set(deviceId, p);
  return p;
}

export function removePlayer(match, deviceId) {
  match.players.delete(deviceId);
}

function freshInput() {
  return { left: false, right: false, up: false, down: false, run: false };
}

/** Held directional state, mirrored from the controller. */
export function setInput(match, deviceId, key, value) {
  const p = match.players.get(deviceId);
  if (!p) return;
  if (key in p.input) p.input[key] = !!value;
}

/** Clear everything held, e.g. after a reconnect where the old session left a key down. */
export function clearInput(match, deviceId) {
  const p = match.players.get(deviceId);
  if (!p) return;
  p.input = freshInput();
  p.pressed = {};
}

/** Latch a one-shot action. The sim consumes it on the next step. */
export function press(match, deviceId, action) {
  const p = match.players.get(deviceId);
  if (!p) return;
  p.pressed[action] = true;
}

/** Set the guard height directly (spec 9). Free and instant - changing guard is not an action. */
export function setGuard(match, deviceId, guard) {
  const p = match.players.get(deviceId);
  if (!p || p.dead) return;
  if (guard !== HIGH && guard !== MID && guard !== LOW) return;
  p.guard = guard;
}

/* ---------------------------------------------------------------- collision */

function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Move along one axis and resolve against the solid list. Resolving axes separately is what
 * makes the controller predictable: a player never gets wedged on a seam between two boxes,
 * because horizontal and vertical penetration are corrected independently.
 */
function moveAxis(p, dx, dy) {
  if (dx !== 0) {
    p.x += dx;
    for (const s of solids) {
      if (!overlaps(p.x, p.y, BODY_W, p.height, s.x, s.y, s.w, s.h)) continue;
      if (dx > 0) { p.x = s.x - BODY_W; } else { p.x = s.x + s.w; }
      p.vx = 0;
      p.wallDir = dx > 0 ? 1 : -1;
    }
  }
  if (dy !== 0) {
    p.y += dy;
    for (const s of solids) {
      if (!overlaps(p.x, p.y, BODY_W, p.height, s.x, s.y, s.w, s.h)) continue;
      if (dy > 0) {
        p.y = s.y - p.height;
        p.vy = 0;
        p.onGround = true;
      } else {
        p.y = s.y + s.h;
        p.vy = 0;
      }
    }
  }
}

/** True if a solid sits directly against the player's side at body height. */
function wallContact(p, dir) {
  const probeX = dir > 0 ? p.x + BODY_W + 1 : p.x - 1;
  for (const s of solids) {
    if (overlaps(probeX, p.y + 6, 1, p.height - 12, s.x, s.y, s.w, s.h)) return true;
  }
  return false;
}

/**
 * True if a standing body placed at this spawn point is clear of every solid.
 *
 * Spec 27 requires that a respawn never lands inside anything. Level furniture moves around
 * as arenas are tuned, so this is checked rather than assumed - a pillar that creeps onto a
 * spawn point otherwise pins the player against it with no way to walk out.
 */
function spawnIsClear(sp) {
  const x = sp.x - BODY_W / 2;
  const y = sp.y - BODY_H;
  for (const s of solids) {
    if (overlaps(x, y, BODY_W, BODY_H, s.x, s.y, s.w, s.h)) return false;
  }
  return true;
}

/** True if the player could stand up here without clipping into a ceiling. */
function canStand(p) {
  const top = p.y + p.height - BODY_H;
  for (const s of solids) {
    if (overlaps(p.x, top, BODY_W, BODY_H, s.x, s.y, s.w, s.h)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------- swords */

/**
 * The blade box for a player, or null when unarmed or in a state with no live weapon.
 * This box is both the hitbox and the parry surface: two blades that overlap at the same
 * guard height block, and that is the whole of the priority system (spec 10).
 */
export function swordBox(p) {
  if (!p.armed || p.dead) return null;
  if (p.state === "knockdown" || p.state === "roll") return null;

  const reach = p.action === "lunge" && p.timer > 0 ? LUNGE_REACH : SWORD_REACH;
  const y = p.y + GUARD_Y[p.guard];
  const x = p.facing > 0 ? p.x + BODY_W : p.x - reach;
  return { x, y, w: reach, h: SWORD_THICK };
}

/** Hurtbox: the body minus the blade. Ducking and crawling shrink it. */
function bodyBox(p) {
  return { x: p.x, y: p.y, w: BODY_W, h: p.height };
}

function dropSword(match, p, vx, vy) {
  p.armed = false;
  match.swords.push({
    x: p.x + BODY_W * 0.5,
    y: p.y + GUARD_Y[p.guard],
    vx: vx || 0,
    vy: vy || 0,
    angle: 0,
    spin: vx ? THROW_SPIN * Math.sign(vx) : 0,
    /** In flight a thrown sword is lethal; once it lands it is only a pickup (spec 15). */
    live: !!vx,
    /** Whoever threw it, so it cannot kill them on the frame it leaves their hand. */
    owner: p.id,
    stuck: false,
    /**
     * Seconds before anyone may pick this blade up. Without it a disarm is meaningless: the
     * sword lands on the victim's own feet and `tryPickup` re-arms them the very next frame,
     * so the kick that disarmed them cost nothing. The delay is what turns a disarm into a
     * real window of unarmed vulnerability.
     */
    pickupDelay: 0.6,
  });
}

/* --------------------------------------------------------------------- step */

/**
 * Advance the match by `dt` seconds. `now` is the room-wide clock (never Date.now()).
 */
export function step(match, dt, now) {
  match.time += dt;
  match.frame++;
  if (match.phase !== "fight") {
    stepCamera(match, dt);
    return;
  }

  for (const p of match.players.values()) stepPlayer(match, p, dt, now);
  stepSwords(match, dt);
  resolveCombat(match, now);
  stepCamera(match, dt);
  checkGoal(match);
}

function stepPlayer(match, p, dt, now) {
  if (p.dead) {
    if (now >= p.respawnAt) respawn(match, p);
    return;
  }

  const inp = p.input;
  p.wallDir = 0;
  p.lethal = false;

  // Committed actions tick down first. While a timer runs the player cannot start anything
  // new - there is no cancelling and no combo system (spec 35).
  if (p.timer > 0) {
    p.timer = Math.max(0, p.timer - dt);
    if (p.timer === 0) finishAction(match, p);
  }

  const busy = p.timer > 0;
  const committed = busy && (p.action === "lunge" || p.action === "thrust" ||
    p.action === "punch" || p.action === "kick" || p.action === "dive" ||
    p.action === "knockdown" || p.action === "roll" || p.action === "land");

  // ---- one-shot intents -------------------------------------------------
  const pressed = p.pressed;
  p.pressed = {};

  if (!committed) {
    if (pressed.attack) startAttack(match, p);
    else if (pressed.throw && p.armed) throwSword(match, p);
    else if (pressed.kick) startKick(match, p);
    else if (pressed.jump) startJump(match, p);
    else if (pressed.roll && p.onGround) startRoll(p);
  }

  // ---- horizontal -------------------------------------------------------
  let dir = 0;
  if (inp.left) dir -= 1;
  if (inp.right) dir += 1;

  // A lunge carries its own forward momentum and ignores steering (spec 18).
  if (p.action === "lunge" && p.timer > 0) {
    p.vx = p.facing * 420;
  } else if (p.action === "roll" && p.timer > 0) {
    p.vx = p.facing * 380;
  } else if (p.action === "dive" && p.timer > 0) {
    p.vx = p.facing * 300;
  } else if (!committed) {
    // Facing follows input, but only when free: you cannot pivot mid-thrust.
    if (dir !== 0) p.facing = dir;

    const crawling = p.state === "crawl";
    const ducking = inp.down && p.onGround;
    let target = 0;
    if (dir !== 0) {
      if (crawling || ducking) target = dir * 90;
      else target = dir * (inp.run ? RUN_SPEED : WALK_SPEED);
    }

    const rate = p.onGround ? (dir === 0 ? FRICTION : ACCEL) : AIR_ACCEL;
    if (p.vx < target) p.vx = Math.min(target, p.vx + rate * dt);
    else if (p.vx > target) p.vx = Math.max(target, p.vx - rate * dt);
  }

  // ---- posture ----------------------------------------------------------
  // Duck and crawl shrink the hurtbox. Standing back up is refused under a ceiling, which is
  // what makes the chokepoint screens' crawl gaps a real commitment.
  let wantHeight = BODY_H;
  if (!committed && p.onGround && inp.down) {
    wantHeight = Math.abs(p.vx) > 20 ? CRAWL_H : DUCK_H;
  }
  if (wantHeight !== p.height) {
    const grow = wantHeight > p.height;
    const prevBottom = p.y + p.height;
    p.height = wantHeight;
    p.y = prevBottom - p.height;
    if (grow && !canStand(p) && wantHeight === BODY_H) {
      // No room: stay ducked.
      p.height = DUCK_H;
      p.y = prevBottom - p.height;
    }
  }

  // ---- vertical ---------------------------------------------------------
  const touchingLeft = wallContact(p, -1);
  const touchingRight = wallContact(p, 1);
  const pushingWall = (touchingLeft && inp.left) || (touchingRight && inp.right);
  const wallDir = touchingLeft ? -1 : touchingRight ? 1 : 0;

  if (!p.onGround && wallDir !== 0 && pushingWall && !committed) {
    // Wall slide, and climb while up is held until the grip runs out (spec 23).
    if (inp.up && p.climbTime < WALL_CLIMB_MAX) {
      p.climbTime += dt;
      p.vy = -WALL_CLIMB_SPEED;
      p.state = "wallclimb";
    } else {
      p.vy = Math.min(p.vy + GRAVITY * dt, WALL_SLIDE_SPEED);
      p.state = "wallslide";
    }
    p.wallDir = wallDir;
  } else {
    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
  }

  if (p.onGround) p.climbTime = 0;

  const wasOnGround = p.onGround;
  p.onGround = false;
  moveAxis(p, p.vx * dt, 0);
  moveAxis(p, 0, p.vy * dt);

  // Landing costs a few frames, so a jump-in is not free (spec 7).
  if (p.onGround && !wasOnGround && p.vy >= 0) {
    if (p.action === "dive") {
      // A dive kick that reaches the floor without connecting leaves you on the ground.
      p.action = "knockdown";
      p.timer = T_KNOCKDOWN * 0.6;
      p.state = "knockdown";
    } else if (!committed) {
      p.action = "land";
      p.timer = T_LAND_RECOVER;
      p.state = "land";
    }
  }

  // ---- environmental death ---------------------------------------------
  if (p.y > KILL_Y) {
    kill(match, p, null, "fall");
    return;
  }

  // ---- state label ------------------------------------------------------
  if (p.timer > 0 && p.action) {
    p.state = p.action;
  } else if (!p.onGround) {
    p.state = p.vy < 0 ? "jump" : "fall";
  } else if (p.height === CRAWL_H) {
    p.state = "crawl";
  } else if (p.height === DUCK_H) {
    p.state = "duck";
  } else if (Math.abs(p.vx) > 200) {
    p.state = "run";
  } else if (Math.abs(p.vx) > 12) {
    p.state = "walk";
  } else {
    p.state = p.armed ? "ready" : "unarmed";
  }

  // Picking a sword back up is automatic on contact (spec 16).
  if (!p.armed) tryPickup(match, p);
}

/* ------------------------------------------------------------------ actions */

function startJump(match, p) {
  const touchingLeft = wallContact(p, -1);
  const touchingRight = wallContact(p, 1);

  if (p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
    p.state = "jump";
    return;
  }
  // Wall jump: away from the wall, and the facing flips with it.
  if (touchingLeft || touchingRight) {
    const away = touchingLeft ? 1 : -1;
    p.vx = away * WALL_JUMP_X;
    p.vy = WALL_JUMP_Y;
    p.facing = away;
    p.climbTime = 0;
    p.state = "walljump";
    match.events.push({ type: "walljump", x: p.x, y: p.y });
  }
}

/**
 * Attack. Armed on the ground is a thrust, or a lunge when running (the longest melee reach,
 * spec 18). Armed in the air is an air stab; unarmed in the air is a dive kick (spec 19).
 */
function startAttack(match, p) {
  if (!p.armed) {
    if (!p.onGround) startDive(match, p);
    else startPunch(match, p);
    return;
  }
  if (!p.onGround) {
    p.action = "thrust";
    p.timer = T_THRUST;
    p.state = "airstab";
    return;
  }
  const lunging = p.input.run && Math.abs(p.vx) > 180;
  p.action = lunging ? "lunge" : "thrust";
  p.timer = lunging ? T_LUNGE : T_THRUST;
  p.state = p.action;
  match.events.push({ type: lunging ? "lunge" : "thrust", x: p.x, y: p.y, id: p.id });
}

function startPunch(match, p) {
  p.action = "punch";
  p.timer = T_PUNCH;
  p.state = "punch";
}

function startKick(match, p) {
  if (!p.onGround) { startDive(match, p); return; }
  p.action = "kick";
  p.timer = T_KICK;
  p.state = "kick";
}

function startDive(match, p) {
  p.action = "dive";
  p.timer = T_DIVE;
  p.state = "divekick";
  p.vy = 420;
  match.events.push({ type: "dive", x: p.x, y: p.y, id: p.id });
}

function startRoll(p) {
  p.action = "roll";
  p.timer = T_ROLL;
  p.state = "roll";
  p.height = CRAWL_H;
}

function throwSword(match, p) {
  // A thrown sword leaves you unarmed, which is the cost of the range (spec 15).
  const vy = p.guard === HIGH ? -120 : p.guard === LOW ? 120 : 0;
  dropSword(match, p, p.facing * THROW_SPEED, vy);
  p.action = "throw";
  p.timer = T_THRUST_RECOVER;
  p.state = "throw";
  match.events.push({ type: "throw", x: p.x, y: p.y, id: p.id });
}

/** Called when a committed action's timer expires. */
function finishAction(match, p) {
  if (p.action === "lunge") {
    // Missing a lunge leaves you planted - the punish window the whole spacing game turns on.
    p.action = "recover";
    p.timer = T_LUNGE_RECOVER;
    p.state = "recover";
    p.vx = 0;
    return;
  }
  if (p.action === "thrust") {
    p.action = "recover";
    p.timer = T_THRUST_RECOVER;
    p.state = "recover";
    return;
  }
  if (p.action === "roll" || p.action === "knockdown") {
    p.height = BODY_H;
    if (!canStand(p)) p.height = DUCK_H;
  }
  p.action = null;
}

/* ------------------------------------------------------------------- combat */

/**
 * Resolve every pairwise interaction for this frame.
 *
 * Order matters and is fixed, so the same frame always resolves the same way: blades clash
 * first (a block or disarm cancels the attacks that caused it), then blades against bodies,
 * then unarmed contact. Deaths are applied after all tests, so a genuine double-hit kills both
 * players rather than letting iteration order pick a winner.
 */
function resolveCombat(match, now) {
  const list = [...match.players.values()].filter((p) => !p.dead);
  const deaths = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      const sa = swordBox(a);
      const sb = swordBox(b);

      // ---- blade vs blade ------------------------------------------------
      if (sa && sb && boxHit(sa, sb)) {
        const attackingA = isAttacking(a);
        const attackingB = isAttacking(b);

        if (a.guard === b.guard) {
          // Matched heights block (spec 10). Both attacks die on the parry.
          if (attackingA) cancelAttack(a);
          if (attackingB) cancelAttack(b);
          match.events.push({ type: "clash", x: (sa.x + sb.x) / 2, y: sa.y });
        } else if (attackingA !== attackingB) {
          // One player swung into a static blade at a different angle: the blade that was
          // already set wins the leverage and disarms the swinger (spec 10, 13).
          const loser = attackingA ? a : b;
          const winner = attackingA ? b : a;
          disarm(match, loser, winner.facing);
          cancelAttack(loser);
          match.events.push({ type: "disarm", x: loser.x, y: loser.y, id: loser.id });
        } else {
          // Both swinging at different heights: blades slide past each other and both
          // continue, so the body tests below decide it.
          match.events.push({ type: "scrape", x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 });
        }
      }

      // ---- blade vs body -------------------------------------------------
      // Re-read the boxes: a clash above may have cancelled an attack.
      const sa2 = swordBox(a);
      const sb2 = swordBox(b);
      if (sa2 && isAttacking(a) && boxHit(sa2, bodyBox(b))) deaths.push([b, a, "sword"]);
      if (sb2 && isAttacking(b) && boxHit(sb2, bodyBox(a))) deaths.push([a, b, "sword"]);

      // ---- unarmed --------------------------------------------------------
      resolveUnarmed(match, a, b, deaths);
      resolveUnarmed(match, b, a, deaths);
    }
  }

  for (const [victim, killer, cause] of deaths) {
    if (!victim.dead) kill(match, victim, killer, cause);
  }
}

/** True while a player's blade is live, as opposed to merely held out in a guard. */
function isAttacking(p) {
  if (p.timer <= 0) return false;
  return p.action === "thrust" || p.action === "lunge";
}

function cancelAttack(p) {
  p.action = "recover";
  p.timer = T_THRUST_RECOVER;
  p.state = "recover";
  p.vx *= 0.2;
}

function boxHit(a, b) {
  return overlaps(a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h);
}

function disarm(match, p, pushDir) {
  if (!p.armed) return;
  dropSword(match, p, (pushDir || p.facing) * 220, -260);
  // The dropped blade is inert; only a deliberate throw is lethal.
  match.swords[match.swords.length - 1].live = false;
}

/**
 * Unarmed offence from `a` against `b` (spec 14, 20, 21). None of it does damage directly -
 * it disarms, shoves, or knocks down, and the neck snap converts that advantage into a kill.
 */
function resolveUnarmed(match, a, b, deaths) {
  if (a.timer <= 0) return;
  const facingB = Math.sign(b.x - a.x) === a.facing || Math.abs(b.x - a.x) < 8;
  if (!facingB) return;

  const dx = Math.abs((b.x + BODY_W / 2) - (a.x + BODY_W / 2));
  const dy = Math.abs((b.y + b.height / 2) - (a.y + a.height / 2));

  if (a.action === "dive" && dy < 56 && dx < KICK_RANGE + 10) {
    // Dive kick: the answer to a sword user. Disarms and knocks down (spec 19).
    if (b.armed) disarm(match, b, a.facing);
    knockDown(match, b, a.facing);
    a.action = null;
    a.timer = 0;
    a.vy = -240;
    match.events.push({ type: "divehit", x: b.x, y: b.y });
    return;
  }

  if (a.action === "kick" && dy < 44 && dx < KICK_RANGE) {
    if (b.armed) disarm(match, b, a.facing);
    knockDown(match, b, a.facing);
    a.action = null;
    a.timer = 0;
    match.events.push({ type: "kick", x: b.x, y: b.y });
    return;
  }

  if (a.action === "punch" && dy < 40 && dx < PUNCH_RANGE) {
    // A punch on a knocked-down or already-stunned opponent is a neck snap: instant kill,
    // but only from very close and only when they are vulnerable (spec 21).
    if (b.state === "knockdown" && dx < NECK_SNAP_RANGE) {
      deaths.push([b, a, "necksnap"]);
      a.action = null;
      a.timer = 0;
      return;
    }
    if (b.armed) {
      // A clean punch to an armed opponent knocks the sword loose (spec 13).
      disarm(match, b, a.facing);
    }
    b.vx = a.facing * PUNCH_SHOVE;
    b.vy = Math.min(b.vy, -90);
    a.action = null;
    a.timer = 0;
    match.events.push({ type: "punch", x: b.x, y: b.y });
  }
}

function knockDown(match, p, dir) {
  p.action = "knockdown";
  p.timer = T_KNOCKDOWN;
  p.state = "knockdown";
  p.height = CRAWL_H;
  p.vx = dir * 200;
  p.vy = -180;
}

/* -------------------------------------------------------------------- death */

/**
 * One-hit lethality, and the only place territory changes hands.
 *
 * Spec 4: if the attacker survives the exchange the camera advances one screen toward the
 * defender's side. The advance is credited to the *killer's* direction, so a defender who
 * kills an intruder pushes the fight back the way it came.
 */
function kill(match, victim, killer, cause) {
  if (victim.dead) return;
  victim.dead = true;
  victim.deaths++;
  victim.respawnAt = 0;   // set below from the room clock
  victim.vx = 0;
  victim.vy = 0;
  victim.action = null;
  victim.timer = 0;
  victim.state = "dead";
  // A dead player's sword falls where they stood, so a kill leaves a weapon on the field.
  if (victim.armed) dropSword(match, victim, 0, -180);

  match.events.push({ type: "death", x: victim.x, y: victim.y, cause, id: victim.id });

  if (killer) {
    killer.kills++;
    advance(match, killer);
  }
}

/**
 * Move the active screen one step toward the killer's goal, clamped to the map.
 *
 * Progress is strictly one screen per kill - there is no way to bank two at once, which is
 * what keeps the match a tug-of-war rather than a race (spec 1, 4).
 */
function advance(match, killer) {
  const dir = killer.side === 0 ? 1 : -1;
  const next = Math.max(MIN_SCREEN, Math.min(MAX_SCREEN, match.screen + dir));
  if (next !== match.screen) {
    match.screen = next;
    match.events.push({ type: "advance", screen: next, side: killer.side });
  }
}

/**
 * Respawn ahead of the attacker, never behind (spec 5, 27).
 *
 * "Ahead" means further along the attacker's direction of travel, so a kill always produces
 * another duel between the attacker and their goal instead of a free run. If no spawn point
 * remains ahead - the attacker is already at the last screen - fall back to the furthest one
 * in that direction so the defender still stands between them and the goal.
 */
function respawn(match, p) {
  const opponent = [...match.players.values()].find((q) => q.id !== p.id);
  const dir = p.side === 0 ? 1 : -1;      // the direction *this* player advances
  const attackerDir = -dir;               // the opponent pushes the other way

  // Candidate spawns must be on the defender's side of the attacker: between the attacker
  // and the goal the attacker is running at.
  const from = opponent ? opponent.x : screenLeft(match.screen) + SCREEN_W / 2;
  let best = null;
  let bestDist = Infinity;

  // Respawns are anchored to the attacker's screen rather than the territory line. The two
  // diverge whenever the attacker has not yet walked into the ground their kill just won, and
  // anchoring to the line would drop the defender a screen away from the only player who can
  // see them - the camera follows the fight, so the fight is where the defender must appear.
  const anchor = opponent ? screenAt(opponent.x) : match.screen;

  for (const sp of spawnPoints) {
    if (!spawnIsClear(sp)) continue;      // never spawn inside geometry
    const rel = (sp.x - from) * attackerDir;
    if (rel <= 40) continue;              // behind or on top of the attacker
    // Keep the respawn inside or adjacent to the attacker's screen, so the fight stays framed.
    const s = screenAt(sp.x);
    if (Math.abs(s - anchor) > 1) continue;
    if (rel < bestDist) { bestDist = rel; best = sp; }
  }

  if (!best) {
    // Nothing ahead on camera: take the furthest spawn in the defender's own direction.
    const fallback = spawnPoints
      .filter((sp) => spawnIsClear(sp) && Math.abs(screenAt(sp.x) - anchor) <= 1)
      .sort((m, n) => (n.x - m.x) * attackerDir)[0];
    best = fallback || { x: screenLeft(anchor) + SCREEN_W / 2, y: GROUND_Y };
  }

  p.x = best.x - BODY_W / 2;
  p.y = best.y - BODY_H;
  p.height = BODY_H;
  p.vx = 0;
  p.vy = 0;
  p.dead = false;
  p.armed = true;          // always respawn with a sword; both players are always equal
  p.guard = MID;
  p.state = "idle";
  p.action = null;
  p.timer = 0;
  p.climbTime = 0;
  p.facing = attackerDir;  // face the incoming attacker
  match.events.push({ type: "respawn", x: p.x, y: p.y, id: p.id });
}

/** Schedule respawns off the room clock. Called by the screen right after `step`. */
export function scheduleRespawns(match, now) {
  for (const p of match.players.values()) {
    if (p.dead && p.respawnAt === 0) p.respawnAt = now + T_RESPAWN * 1000;
  }
}

/* ------------------------------------------------------------------- swords */

function stepSwords(match, dt) {
  for (const s of match.swords) {
    if (s.pickupDelay > 0) s.pickupDelay = Math.max(0, s.pickupDelay - dt);
    if (s.stuck) continue;

    // A blade in flight barely drops: at 720px/s it must still be at chest height a full
    // screen away, or throwing is only ever a short-range option and the spec's "projectile
    // that sticks into the far wall" never happens. Once it has landed and gone inert it
    // falls normally, so a disarmed sword still drops to the floor to be picked up.
    const dropRate = s.live ? GRAVITY * 0.06 : GRAVITY * 0.6;
    s.vy = Math.min(s.vy + dropRate * dt, MAX_FALL);
    s.angle += s.spin * dt;

    const nx = s.x + s.vx * dt;
    const ny = s.y + s.vy * dt;

    // A thrown blade sticks into the first surface it reaches (spec 15).
    let hit = null;
    for (const solid of solids) {
      if (overlaps(nx - 4, ny - 4, 8, 8, solid.x, solid.y, solid.w, solid.h)) { hit = solid; break; }
    }
    if (hit) {
      s.stuck = true;
      s.live = false;
      s.vx = 0;
      s.vy = 0;
      // Rest flat on a floor, or buried in a wall.
      s.angle = ny <= hit.y + 6 ? 0 : s.angle;
      s.x = nx;
      s.y = Math.min(ny, hit.y);
      match.events.push({ type: "stick", x: s.x, y: s.y });
      continue;
    }

    s.x = nx;
    s.y = ny;
    if (s.y > KILL_Y) { s.dropped = true; }
  }

  // A blade that fell out of the world is gone; recycle it at the centre so the round can
  // never reach a state with no weapons on the field.
  for (const s of match.swords) {
    if (s.dropped) {
      s.dropped = false;
      s.stuck = true;
      s.live = false;
      s.x = screenLeft(match.screen) + SCREEN_W / 2;
      s.y = GROUND_Y;
      s.vx = 0;
      s.vy = 0;
      s.angle = 0;
      s.pickupDelay = 0;
    }
  }

  // A live thrown blade kills whoever it reaches, except the thrower on the way out.
  for (const s of match.swords) {
    if (!s.live) continue;
    for (const p of match.players.values()) {
      if (p.dead || p.id === s.owner) continue;
      const b = bodyBox(p);
      if (overlaps(s.x - 6, s.y - 4, 12, 8, b.x, b.y, b.w, b.h)) {
        s.live = false;
        s.stuck = true;
        s.vx = 0;
        s.vy = 0;
        const killer = [...match.players.values()].find((q) => q.id === s.owner);
        kill(match, p, killer || null, "throw");
      }
    }
  }
}

/** Walking over a loose sword re-arms instantly (spec 16). */
function tryPickup(match, p) {
  const b = bodyBox(p);
  for (let i = 0; i < match.swords.length; i++) {
    const s = match.swords[i];
    if (s.live || s.pickupDelay > 0) continue;
    if (!overlaps(s.x - 10, s.y - 10, 20, 20, b.x, b.y, b.w, b.h)) continue;
    match.swords.splice(i, 1);
    p.armed = true;
    match.events.push({ type: "pickup", x: p.x, y: p.y, id: p.id });
    return;
  }
}

/* ------------------------------------------------------------------- camera */

/**
 * The camera is locked to a whole screen and only ever moves between screens (spec 25, 26).
 * The ease is short - it reads as a snap with a little travel, not a pan you could fight in.
 *
 * It shows the screen the living players are actually on, not `match.screen` directly.
 * Territory advances the instant a kill lands, but the attacker is still standing where they
 * killed; pointing the camera at the newly-won screen strands both fencers off-frame and the
 * viewer watches an empty arena until somebody walks into it. Following the fight keeps the
 * duel on screen, and the camera arrives at the new territory as soon as the attacker does.
 */
function cameraTargetScreen(match) {
  const living = [...match.players.values()].filter((p) => !p.dead);
  if (living.length === 0) return match.screen;

  // Where the fight is. With both alive, favour the attacker's half of the contested ground
  // by taking the screen nearest the active territory line.
  const screens = living.map((p) => screenAt(p.x));
  let best = screens[0];
  let bestDist = Math.abs(best - match.screen);
  for (const s of screens) {
    const d = Math.abs(s - match.screen);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return Math.max(MIN_SCREEN, Math.min(MAX_SCREEN, best));
}

function stepCamera(match, dt) {
  const targetX = screenLeft(cameraTargetScreen(match));
  const delta = targetX - match.cameraX;
  if (Math.abs(delta) < 1) {
    match.cameraX = targetX;
    match.cameraScreen = screenAt(match.cameraX + SCREEN_W / 2);
  } else {
    match.cameraX += delta * Math.min(1, dt * 7);
  }
}

/* -------------------------------------------------------------------- goal */

/**
 * Winning is territorial and nothing else: reach the far edge of the last screen on the
 * opponent's side (spec 2). Kills are never points.
 */
function checkGoal(match) {
  for (const p of match.players.values()) {
    if (p.dead) continue;
    if (p.side === 0 && p.x + BODY_W >= GOAL_RIGHT - 4 && match.screen === MAX_SCREEN) {
      win(match, p);
      return;
    }
    if (p.side === 1 && p.x <= GOAL_LEFT + 4 && match.screen === MIN_SCREEN) {
      win(match, p);
      return;
    }
  }
}

function win(match, p) {
  match.phase = "over";
  match.winner = p.id;
  match.events.push({ type: "win", id: p.id, x: p.x, y: p.y });
}

/** Start or restart a round with the current roster. */
export function restart(match) {
  match.screen = 0;
  match.cameraScreen = 0;
  match.cameraX = screenLeft(0);
  match.swords.length = 0;
  match.winner = null;
  match.phase = "fight";
  match.events.push({ type: "start" });

  for (const p of match.players.values()) {
    const start = startPointFor(p.side);
    p.x = start.x - BODY_W / 2;
    p.y = start.y - BODY_H;
    p.vx = 0;
    p.vy = 0;
    p.height = BODY_H;
    p.facing = p.side === 0 ? 1 : -1;
    p.armed = true;
    p.guard = MID;
    p.dead = false;
    p.state = "idle";
    p.action = null;
    p.timer = 0;
    p.kills = 0;
    p.deaths = 0;
    p.input = freshInput();
    p.pressed = {};
  }
}

/**
 * Where a side starts a round: opposite ends of the centre screen.
 *
 * Both fencers have to open the match on camera. Starting them a screen back on their own
 * side is tempting for symmetry, but the camera only ever shows the active screen - so the
 * round would begin on an empty frame and stay that way until somebody walked into it.
 */
function startPointFor(side) {
  const candidates = spawnPoints
    .filter((sp) => screenAt(sp.x) === 0 && spawnIsClear(sp))
    .sort((a, b) => a.x - b.x);
  if (candidates.length === 0) {
    const middle = SCREEN_W * 0.5;
    return { x: side === 0 ? middle - 200 : middle + 200, y: GROUND_Y };
  }
  // Leftmost clear spawn for the left player, rightmost for the right.
  return side === 0 ? candidates[0] : candidates[candidates.length - 1];
}

/** Assign sides so the lower device id always takes the left edge. */
export function assignSides(match) {
  const ids = [...match.players.keys()].sort((a, b) => a - b);
  ids.forEach((id, i) => {
    const p = match.players.get(id);
    if (p) p.side = i === 0 ? 0 : 1;
  });
}

export { BODY_W, BODY_H, DUCK_H, CRAWL_H, SWORD_REACH, LUNGE_REACH, GUARD_Y, T_RESPAWN };
