import type { Character } from "./characters";

// A 2D side-view volleyball match, 1v1 or 2v2, after the Classic mode of Powa Volley (Kydos,
// Xbox Live Indie Games): you hit the ball by running and jumping into it, the serve floats still
// above the server who gets one touch to send it over, and only the serving side scores. Pure and
// deterministic: the page feeds it inputs at a fixed step and draws the state, and the unit tests
// drive it the same way. Units are pixels on an 800×450 court and seconds; y grows downwards.

export const COURT_W = 800;
export const COURT_H = 450;
export const GROUND_Y = 410;
export const NET_X = COURT_W / 2;
export const NET_HALF_W = 5;
export const NET_TOP = 290;
/** Simulation step: 120 Hz. */
export const STEP = 1 / 120;

export const BALL_R = 17;
export const BALL_GRAVITY = 1050;
const BALL_MAX_SPEED = 1150;
/** A body sends the ball off at this speed along the contact normal, plus some of its own. */
const BOUNCE_SPEED = 640;
const CARRY_X = 0.3;
const CARRY_UP = 0.4;

export const PLAYER_R = 34;
const PLAYER_GRAVITY = 2100;
export const RUN_SPEED = 340;
const JUMP_HEIGHT = 180;
/** Letting go of jump early cuts the jump short. */
const SHORT_JUMP_GRAVITY = 2.4;
/** One contact counts once, however many steps the ball stays against the body. */
const TOUCH_COOLDOWN = 0.2;

export const MAX_TOUCHES = 3;
export const SERVE_Y = 205;
/** A server who never touches the ball loses the wait: it drops on its own. */
const SERVE_WAIT = 10;
const POINT_PAUSE = 1.4;

/**
 * The jungle monkey walks along the roof of the court. Pass him the ball and he catches it and
 * spikes it at the other side: at the nearest player who didn't send it to him.
 */
export const MONKEY_R = 24;
/** Height of his middle, hanging under the roof beam. */
export const MONKEY_Y = 44;
const MONKEY_SPEED = 110;
const MONKEY_HOLD = 0.35;
const MONKEY_SPIKE_SPEED = 900;

export type Side = 0 | 1;
export const otherSide = (side: Side): Side => (side === 0 ? 1 : 0);
/** Which way is "over the net" for a side. */
export const towardNet = (side: Side) => (side === 0 ? 1 : -1);

export type CourtId = "beach" | "jungle";

export interface Input {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export const NO_INPUT: Input = { left: false, right: false, jump: false };

export interface Player {
  side: Side;
  /** Position in the team: 0 or 1. */
  slot: number;
  character: Character;
  /** Feet position: (x, y) is the bottom centre of the body. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  touchCooldown: number;
  /** Seconds since the last touch, for the squash animation. */
  sinceTouch: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Rotation for drawing, in radians. */
  angle: number;
  /** False while it floats still above the server. */
  live: boolean;
  /** True from the serve until the ball first crosses the net: the serving side gets one touch. */
  serving: boolean;
  /** Side that touched it last, and how many touches in a row that side has made. */
  lastSide: Side | null;
  touches: number;
}

export interface Monkey {
  x: number;
  y: number;
  /** +1 walking right, -1 left. */
  dir: number;
  time: number;
  /** Seconds left holding a caught ball before he spikes it; null when his hands are free. */
  holding: number | null;
  /** The side he'll spike at. */
  target: Side;
  /** Seconds before he can catch again, so a ball he just spiked doesn't come straight back. */
  rest: number;
}

export type RallyEnd = "ground" | "touches" | "serve";

export type Phase =
  | { kind: "serve"; time: number }
  | { kind: "rally" }
  | {
      kind: "point";
      time: number;
      winner: Side;
      reason: RallyEnd;
      /** True when the rally winner was serving and scored; false for a side-out. */
      scored: boolean;
    }
  | { kind: "over"; winner: Side };

export interface MatchOptions {
  /** One character per player: side 0's team first, then side 1's. 2 players or 4. */
  characters: Character[];
  /** Points needed to win; a match must also be won by two. */
  target: number;
  court: CourtId;
  seed?: number;
}

export interface Match {
  players: Player[];
  teamSize: 1 | 2;
  ball: Ball;
  score: [number, number];
  target: number;
  serving: Side;
  /** Which slot serves next for each team; a team rotates when it wins the serve back. */
  nextServer: [number, number];
  phase: Phase;
  court: CourtId;
  monkey: Monkey | null;
  nextMonkey: number;
  /** Seconds since the match began, for animation. */
  time: number;
  rng: number;
}

export type GameEvent =
  | { type: "touch"; side: Side; slot: number }
  | { type: "net" }
  | { type: "wall" }
  | { type: "monkey-arrives" }
  | { type: "monkey-catch" }
  | { type: "monkey-spike"; target: Side }
  | { type: "rally-over"; winner: Side; reason: RallyEnd; scored: boolean }
  | { type: "win"; winner: Side };

/** mulberry32: a tiny seeded generator, so a match replays the same from the same seed. */
function random(match: Match): number {
  match.rng = (match.rng + 0x6d2b79f5) | 0;
  let t = match.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Where a player stands at the start of a rally. */
export function homeX(side: Side, slot: number, teamSize: number): number {
  const fromLeft = teamSize === 1 ? COURT_W * 0.25 : slot === 0 ? COURT_W * 0.16 : COURT_W * 0.36;
  return side === 0 ? fromLeft : COURT_W - fromLeft;
}

/** Centre of the player's round body. */
export const bodyCenter = (player: Player) => ({ x: player.x, y: player.y - PLAYER_R });

/** Leftmost and rightmost feet positions on the player's own half. */
export function playerBounds(side: Side): [number, number] {
  return side === 0
    ? [PLAYER_R, NET_X - NET_HALF_W - PLAYER_R]
    : [NET_X + NET_HALF_W + PLAYER_R, COURT_W - PLAYER_R];
}

/** The player who serves this rally. */
export function serverOf(match: Match): Player {
  return teamOf(match, match.serving)[match.nextServer[match.serving]]!;
}

export const teamOf = (match: Match, side: Side) =>
  match.players.filter((player) => player.side === side);

function servingBall(match: Match): Ball {
  const server = serverOf(match);
  return {
    x: homeX(server.side, server.slot, match.teamSize),
    y: SERVE_Y,
    vx: 0,
    vy: 0,
    angle: 0,
    live: false,
    serving: true,
    lastSide: null,
    touches: 0,
  };
}

export function createMatch(options: MatchOptions): Match {
  const teamSize = options.characters.length === 4 ? 2 : 1;
  const players = options.characters.map((character, index): Player => {
    const side: Side = index < teamSize ? 0 : 1;
    const slot = index % teamSize;
    return {
      side,
      slot,
      character,
      x: homeX(side, slot, teamSize),
      y: GROUND_Y,
      vx: 0,
      vy: 0,
      onGround: true,
      touchCooldown: 0,
      sinceTouch: 10,
    };
  });
  const match: Match = {
    players,
    teamSize,
    ball: undefined as unknown as Ball,
    score: [0, 0],
    target: options.target,
    serving: 0,
    nextServer: [0, 0],
    phase: { kind: "serve", time: 0 },
    court: options.court,
    monkey: null,
    nextMonkey: 0,
    time: 0,
    rng: options.seed ?? 1,
  };
  match.serving = random(match) < 0.5 ? 0 : 1;
  match.ball = servingBall(match);
  match.nextMonkey = 4 + random(match) * 6;
  return match;
}

/** Puts everyone home and the ball above the next server. */
function resetRally(match: Match) {
  for (const player of match.players) {
    player.x = homeX(player.side, player.slot, match.teamSize);
    player.y = GROUND_Y;
    player.vx = 0;
    player.vy = 0;
    player.onGround = true;
  }
  match.ball = servingBall(match);
  match.phase = { kind: "serve", time: 0 };
}

/** True once a side has reached the target with a two-point lead. */
export function winnerOf(score: [number, number], target: number): Side | null {
  for (const side of [0, 1] as const) {
    const lead = score[side] - score[otherSide(side)];
    if (score[side] >= target && lead >= 2) return side;
  }
  return null;
}

/**
 * Side-out scoring: the serving side scores when it wins the rally; when the other side wins, the
 * serve passes to it (and to its next player in 2v2) with no point.
 */
function endRally(match: Match, winner: Side, reason: RallyEnd, events: GameEvent[]) {
  const scored = winner === match.serving;
  if (scored) match.score[winner] += 1;
  else {
    match.serving = winner;
    match.nextServer[winner] = (match.nextServer[winner] + 1) % match.teamSize;
  }
  match.phase = { kind: "point", time: 0, winner, reason, scored };
  events.push({ type: "rally-over", winner, reason, scored });
}

/** Counts a touch: one on the serve, three a side after that. Going over is a fault. */
function registerTouch(match: Match, player: Player, events: GameEvent[]) {
  const { ball } = match;
  player.touchCooldown = TOUCH_COOLDOWN;
  player.sinceTouch = 0;
  events.push({ type: "touch", side: player.side, slot: player.slot });
  if (!ball.live) {
    ball.live = true;
    match.phase = { kind: "rally" };
  }
  if (ball.lastSide === player.side) ball.touches += 1;
  else {
    ball.lastSide = player.side;
    ball.touches = 1;
  }
  const allowed = ball.serving ? 1 : MAX_TOUCHES;
  if (ball.touches > allowed && match.phase.kind === "rally") {
    endRally(match, otherSide(player.side), ball.serving ? "serve" : "touches", events);
  }
}

function clampSpeed(ball: Ball) {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > BALL_MAX_SPEED) {
    ball.vx *= BALL_MAX_SPEED / speed;
    ball.vy *= BALL_MAX_SPEED / speed;
  }
}

function movePlayer(match: Match, player: Player, input: Input, dt: number) {
  player.touchCooldown = Math.max(0, player.touchCooldown - dt);
  player.sinceTouch += dt;

  const frozen = match.phase.kind === "over";
  const direction = frozen ? 0 : Number(input.right) - Number(input.left);
  player.vx = direction * RUN_SPEED;

  if (!frozen && player.onGround && input.jump) {
    player.vy = -Math.sqrt(2 * PLAYER_GRAVITY * JUMP_HEIGHT);
    player.onGround = false;
  }
  if (!player.onGround) {
    const cut = player.vy < 0 && !input.jump ? SHORT_JUMP_GRAVITY : 1;
    player.vy += PLAYER_GRAVITY * cut * dt;
  }
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  if (player.y >= GROUND_Y) {
    player.y = GROUND_Y;
    player.vy = 0;
    player.onGround = true;
  }
  const [min, max] = playerBounds(player.side);
  player.x = Math.min(max, Math.max(min, player.x));
}

/** The ball bounces off a body it overlaps, taking some of the body's own speed. */
function collideWithPlayer(match: Match, player: Player, events: GameEvent[]) {
  const { ball } = match;
  // The floating serve belongs to the server alone.
  if (!ball.live && player !== serverOf(match)) return;
  const center = bodyCenter(player);
  const dx = ball.x - center.x;
  const dy = ball.y - center.y;
  const distance = Math.hypot(dx, dy);
  const minimum = PLAYER_R + BALL_R;
  if (distance >= minimum) return;

  const nx = distance > 0 ? dx / distance : 0;
  const ny = distance > 0 ? dy / distance : -1;
  ball.x = center.x + nx * (minimum + 0.5);
  ball.y = center.y + ny * (minimum + 0.5);

  if (player.touchCooldown > 0) {
    // Still the same contact: keep it rolling off, don't count it again.
    const away = ball.vx * nx + ball.vy * ny;
    if (away < BOUNCE_SPEED * 0.5) {
      ball.vx += (BOUNCE_SPEED * 0.5 - away) * nx;
      ball.vy += (BOUNCE_SPEED * 0.5 - away) * ny;
    }
    player.touchCooldown = TOUCH_COOLDOWN;
    return;
  }
  ball.vx = nx * BOUNCE_SPEED + player.vx * CARRY_X;
  ball.vy = ny * BOUNCE_SPEED + Math.min(0, player.vy) * CARRY_UP;
  clampSpeed(ball);
  if (match.phase.kind === "rally" || match.phase.kind === "serve") {
    registerTouch(match, player, events);
  } else {
    player.touchCooldown = TOUCH_COOLDOWN;
  }
}

/** Pushes a ball out of a circle and reflects it; true if they touched. */
function bounceOffCircle(ball: Ball, x: number, y: number, r: number, restitution: number) {
  const dx = ball.x - x;
  const dy = ball.y - y;
  const distance = Math.hypot(dx, dy);
  if (distance >= r + BALL_R) return false;
  const nx = distance > 0 ? dx / distance : 0;
  const ny = distance > 0 ? dy / distance : 1;
  ball.x = x + nx * (r + BALL_R);
  ball.y = y + ny * (r + BALL_R);
  const along = ball.vx * nx + ball.vy * ny;
  if (along < 0) {
    ball.vx -= (1 + restitution) * along * nx;
    ball.vy -= (1 + restitution) * along * ny;
  }
  return true;
}

function collideWithNet(ball: Ball, events: GameEvent[]) {
  const left = NET_X - NET_HALF_W;
  const right = NET_X + NET_HALF_W;
  if (ball.y < NET_TOP) {
    // Above the tape: the rounded top of the post.
    if (bounceOffCircle(ball, NET_X, NET_TOP, NET_HALF_W, 0.6)) events.push({ type: "net" });
    return;
  }
  if (ball.x + BALL_R <= left || ball.x - BALL_R >= right) return;
  // Against the side of the net: back to the side the ball came from.
  // A step moves the ball less than its radius, so its centre is still on the side it came from.
  const fromLeft = ball.x < NET_X;
  ball.x = fromLeft ? left - BALL_R : right + BALL_R;
  ball.vx = (fromLeft ? -1 : 1) * Math.abs(ball.vx) * 0.6;
  events.push({ type: "net" });
}

function moveBall(match: Match, dt: number, events: GameEvent[]) {
  const { ball } = match;
  if (!ball.live) {
    ball.vx = 0;
    ball.vy = 0;
    return;
  }
  // In the monkey's hands.
  if (match.monkey?.holding != null) return;
  const wasLeft = ball.x < NET_X;
  ball.vy += BALL_GRAVITY * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.angle += (ball.vx / BALL_R) * dt * 0.6;

  if (ball.x < BALL_R || ball.x > COURT_W - BALL_R) {
    ball.x = Math.min(COURT_W - BALL_R, Math.max(BALL_R, ball.x));
    ball.vx = -ball.vx * 0.85;
    events.push({ type: "wall" });
  }
  collideWithNet(ball, events);
  if (ball.serving && ball.lastSide !== null && wasLeft !== ball.x < NET_X) ball.serving = false;

  if (ball.y + BALL_R >= GROUND_Y) {
    ball.y = GROUND_Y - BALL_R;
    ball.vy = -Math.abs(ball.vy) * 0.45;
    ball.vx *= 0.7;
    if (match.phase.kind === "rally") {
      const landedOn: Side = ball.x < NET_X ? 0 : 1;
      endRally(match, otherSide(landedOn), "ground", events);
    }
  }
}

/** The monkey throws the ball he's holding at the nearest player on his target side. */
function monkeySpike(match: Match, monkey: Monkey, events: GameEvent[]) {
  const { ball } = match;
  const targets = teamOf(match, monkey.target);
  const victim = targets.reduce((best, player) =>
    Math.abs(player.x - monkey.x) < Math.abs(best.x - monkey.x) ? player : best,
  );
  // Aimed at the top of their head, along a short arc.
  const aimX = victim.x;
  const aimY = victim.y - PLAYER_R * 2 - BALL_R;
  const t = Math.max(0.25, Math.hypot(aimX - ball.x, aimY - ball.y) / MONKEY_SPIKE_SPEED);
  ball.vx = (aimX - ball.x) / t;
  ball.vy = (aimY - ball.y - 0.5 * BALL_GRAVITY * t * t) / t;
  // The passer's side gets the credit: the other side starts with three touches.
  ball.lastSide = otherSide(monkey.target);
  ball.touches = 0;
  ball.serving = false;
  events.push({ type: "monkey-spike", target: monkey.target });
}

function updateMonkey(match: Match, dt: number, events: GameEvent[]) {
  if (match.court !== "jungle") return;
  const monkey = match.monkey;
  const { ball } = match;
  if (monkey) {
    monkey.time += dt;
    if (monkey.holding !== null) {
      if (match.phase.kind !== "rally") {
        monkey.holding = null;
        return;
      }
      ball.x = monkey.x + monkey.dir * 4;
      ball.y = monkey.y + MONKEY_R + BALL_R - 8;
      monkey.holding -= dt;
      if (monkey.holding <= 0) {
        monkey.holding = null;
        monkey.rest = 0.6;
        monkeySpike(match, monkey, events);
      }
      return;
    }
    monkey.rest = Math.max(0, monkey.rest - dt);
    monkey.x += monkey.dir * MONKEY_SPEED * dt;
    if (monkey.x < -MONKEY_R * 2 || monkey.x > COURT_W + MONKEY_R * 2) {
      match.monkey = null;
      match.nextMonkey = 6 + random(match) * 8;
      return;
    }
    const reach = MONKEY_R + BALL_R;
    const caught = Math.hypot(ball.x - monkey.x, ball.y - monkey.y) < reach;
    if (caught && ball.live && match.phase.kind === "rally" && monkey.rest <= 0) {
      monkey.holding = MONKEY_HOLD;
      // At the side that didn't pass it to him; a ball nobody touched goes at the far side.
      const passer = ball.lastSide ?? (ball.x < NET_X ? 0 : 1);
      monkey.target = otherSide(passer);
      ball.vx = 0;
      ball.vy = 0;
      events.push({ type: "monkey-catch" });
    }
    return;
  }
  if (match.phase.kind !== "rally") return;
  match.nextMonkey -= dt;
  if (match.nextMonkey > 0) return;
  const dir = random(match) < 0.5 ? 1 : -1;
  match.monkey = {
    x: dir > 0 ? -MONKEY_R * 2 : COURT_W + MONKEY_R * 2,
    y: MONKEY_Y,
    dir,
    time: 0,
    holding: null,
    target: 0,
    rest: 0,
  };
  events.push({ type: "monkey-arrives" });
}

/** Advances the match by one fixed step and returns what happened, for sounds and messages. */
export function step(match: Match, inputs: readonly Input[], dt = STEP): GameEvent[] {
  const events: GameEvent[] = [];
  match.time += dt;
  const phase = match.phase;

  if (phase.kind === "serve") {
    phase.time += dt;
    if (phase.time > SERVE_WAIT) {
      match.ball.live = true;
      match.ball.lastSide = match.serving;
      match.ball.touches = 1;
      match.phase = { kind: "rally" };
    }
  }
  if (phase.kind === "point") {
    phase.time += dt;
    if (phase.time >= POINT_PAUSE) {
      const winner = winnerOf(match.score, match.target);
      if (winner !== null) {
        match.phase = { kind: "over", winner };
        events.push({ type: "win", winner });
      } else resetRally(match);
      return events;
    }
  }

  match.players.forEach((player, index) =>
    movePlayer(match, player, inputs[index] ?? NO_INPUT, dt),
  );
  moveBall(match, dt, events);
  for (const player of match.players) collideWithPlayer(match, player, events);
  updateMonkey(match, dt, events);
  return events;
}
