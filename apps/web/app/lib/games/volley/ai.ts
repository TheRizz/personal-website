import {
  BALL_GRAVITY,
  BALL_R,
  COURT_W,
  GROUND_Y,
  MAX_TOUCHES,
  NET_HALF_W,
  NET_TOP,
  NET_X,
  NO_INPUT,
  PLAYER_R,
  RUN_SPEED,
  STEP,
  homeX,
  step,
  towardNet,
  type Input,
  type Match,
} from "./engine";

// The computer player. When the ball's path changes it tries a handful of plans (where to stand,
// when to jump) on a copy of the match and keeps the one that sends the ball over best; between
// changes it just follows that plan. Easier levels try fewer plans, aim worse and react later.

export type CpuLevel = "easy" | "normal" | "hard";

interface LevelSettings {
  /** Seconds before the CPU notices the ball's new path. */
  reaction: number;
  /** Random error added to where it stands, in pixels. */
  aim: number;
  /** Chance of misjudging a ball the other side sent over, so rallies can be won. */
  miss: number;
  offsets: number[];
  /** Whether it sets the ball up near the net instead of always sending it straight over. */
  sets: boolean;
  jumps: (number | null)[];
}

const LEVELS: Record<CpuLevel, LevelSettings> = {
  easy: {
    reaction: 0.28,
    aim: 26,
    miss: 0.3,
    offsets: [6, 20, 34],
    sets: false,
    jumps: [null, 190, 240],
  },
  normal: {
    reaction: 0.14,
    aim: 10,
    miss: 0.12,
    offsets: [-4, 8, 18, 28, 40],
    sets: true,
    jumps: [null, 140, 190, 260],
  },
  hard: {
    reaction: 0.05,
    aim: 2,
    miss: 0.04,
    offsets: [-12, -4, 4, 12, 20, 28, 36, 46],
    sets: true,
    jumps: [null, 110, 150, 190, 230, 300],
  },
};

/** The height the CPU meets the ball at: just above a standing player's head. */
const HEAD_HEIGHT = PLAYER_R * 2 + BALL_R;
/** What a good set is worth, between a weak return over the net and a likely winner. */
const SET_VALUE = 78;

/** Plans are checked again this often even when the ball's path hasn't changed. */
const REPLAN_EVERY = 0.5;

/** Stand at `x` (in court pixels) and jump once the ball is within `jump` pixels above the body. */
interface Plan {
  x: number;
  jump: number | null;
}

/** Where the ball, untouched, comes down to `height` above the ground. Null if it never does. */
export function predictLanding(match: Match, height: number): number | null {
  const ball = match.ball;
  if (!ball.live) return ball.x;
  let { x, y, vx, vy } = ball;
  const level = GROUND_Y - height;
  for (let t = 0; t < 4; t += STEP) {
    vy += BALL_GRAVITY * STEP;
    x += vx * STEP;
    y += vy * STEP;
    if (x < BALL_R || x > COURT_W - BALL_R) {
      x = Math.min(COURT_W - BALL_R, Math.max(BALL_R, x));
      vx = -vx * 0.85;
    }
    if (y > NET_TOP && Math.abs(x - NET_X) < NET_HALF_W + BALL_R) {
      x = x < NET_X ? NET_X - NET_HALF_W - BALL_R : NET_X + NET_HALF_W + BALL_R;
      vx = -vx * 0.6;
    }
    if (vy > 0 && y >= level) return x;
  }
  return null;
}

/** The inputs that carry out `plan` for the player at `index` right now. */
function follow(match: Match, index: number, plan: Plan): Input {
  const me = match.players[index]!;
  const dx = plan.x - me.x;
  const input = { left: dx < -3, right: dx > 3, jump: false };
  if (plan.jump !== null && me.onGround) {
    const ball = match.ball;
    const above = me.y - PLAYER_R - ball.y;
    if (Math.abs(dx) < 14 && Math.abs(ball.x - me.x) < 90 && above > 0 && above < plan.jump) {
      input.jump = true;
    }
  }
  // Keep the jump held so it isn't cut short.
  if (!me.onGround && me.vy < 0) input.jump = true;
  return input;
}

/** How good a plan turned out on a copy of the match: positive is good for the CPU's side. */
function score(match: Match, index: number, plan: Plan, sets: boolean): number {
  const copy = structuredClone(match);
  const me = copy.players[index]!;
  const inputs: Input[] = copy.players.map(() => NO_INPUT);
  const opponents = copy.players.filter((player) => player.side !== me.side).map((p) => p.x);
  let touched = false;
  let crossed = false;
  let crossedAt = 0;
  for (let t = 0; t < 4.5; t += STEP) {
    inputs[index] = crossed ? NO_INPUT : follow(copy, index, plan);
    for (const event of step(copy, inputs)) {
      if (event.type === "touch") {
        if (event.side !== me.side) return 40;
        if (event.slot !== me.slot) return -5;
        // A set: up and coming down near the net on our side, for the next touch to attack.
        if (sets && !touched && !copy.ball.serving && copy.ball.touches < MAX_TOUCHES) {
          const landing = predictLanding(copy, HEAD_HEIGHT);
          const fromNet = landing === null ? 0 : (NET_X - landing) * towardNet(me.side);
          if (fromNet > 45 && fromNet < 160) return SET_VALUE;
        }
        touched = true;
      }
      if (event.type === "rally-over") {
        if (event.winner !== me.side) return -100;
        if (!crossed) return 100;
        // Over and down: better the less time the other side has to run to it.
        const ball = copy.ball;
        const run = Math.min(...opponents.map((x) => Math.abs(x - ball.x))) / RUN_SPEED;
        return 60 + 30 * Math.max(-1, Math.min(1.5, run - (t - crossedAt)));
      }
    }
    if (touched && !crossed) {
      const ball = copy.ball;
      crossed = me.side === 0 ? ball.x > NET_X + BALL_R : ball.x < NET_X - BALL_R;
      if (crossed) crossedAt = t;
    }
  }
  return touched ? -40 : -60;
}

function mulberry(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CpuPlayer {
  private plan: Plan | null = null;
  private replanIn = 0;
  private lastPath = "";
  /** Extra aim error for the whole of the current path, when the CPU misjudges it. */
  private misjudged = 0;
  private readonly settings: LevelSettings;
  private readonly random: () => number;

  constructor(
    private readonly index: number,
    level: CpuLevel,
    seed = 7,
  ) {
    this.settings = LEVELS[level];
    this.random = mulberry(seed + index * 101);
  }

  input(match: Match): Input {
    const me = match.players[this.index]!;
    const phase = match.phase.kind;
    if (phase === "over") return NO_INPUT;
    if (phase === "point") {
      this.plan = null;
      return NO_INPUT;
    }

    // A new path (a touch, a bounce, a fresh serve) means a new plan after the reaction time.
    const ball = match.ball;
    const path = `${phase}:${ball.lastSide}:${ball.touches}:${Math.sign(ball.vx)}:${Math.round(ball.vx / 40)}`;
    if (path !== this.lastPath) {
      this.lastPath = path;
      const incoming = ball.live && ball.lastSide !== me.side;
      const miss = incoming && this.random() < this.settings.miss;
      this.misjudged = miss ? (this.random() < 0.5 ? -1 : 1) * (45 + this.random() * 30) : 0;
      this.replanIn = this.settings.reaction;
    }
    this.replanIn -= STEP;
    if (this.replanIn <= 0) {
      this.plan = this.choose(match);
      this.replanIn = REPLAN_EVERY;
    }

    if (!this.plan) {
      return follow(match, this.index, { x: homeX(me.side, me.slot, match.teamSize), jump: null });
    }
    return follow(match, this.index, this.plan);
  }

  /** The best plan for the ball's current path, or null to wait at home. */
  private choose(match: Match): Plan | null {
    const me = match.players[this.index]!;
    const dir = towardNet(me.side);
    const ball = match.ball;
    if (match.phase.kind === "serve") {
      const server = match.players.find(
        (player) =>
          player.side === match.serving && player.slot === match.nextServer[match.serving],
      );
      if (server !== me) return null;
    }
    const landing = predictLanding(match, HEAD_HEIGHT);
    if (landing === null) return null;
    const mine = me.side === 0 ? landing < NET_X : landing > NET_X;
    if (!mine && ball.live) return null;
    if (match.teamSize === 2 && ball.live && !this.isMyZone(match, landing)) return null;

    const aim = (this.random() * 2 - 1) * this.settings.aim + this.misjudged;
    let best: Plan | null = null;
    let bestScore = -Infinity;
    for (const offset of this.settings.offsets) {
      for (const jump of this.settings.jumps) {
        const plan = { x: landing - dir * offset + aim, jump };
        const value = score(match, this.index, plan, this.settings.sets);
        if (value > bestScore) {
          bestScore = value;
          best = plan;
        }
      }
    }
    return best;
  }

  /** In 2v2 the back player takes balls behind the middle of the half, the front one the rest. */
  private isMyZone(match: Match, landing: number): boolean {
    const me = match.players[this.index]!;
    const split = (homeX(me.side, 0, 2) + homeX(me.side, 1, 2)) / 2;
    const behind = me.side === 0 ? landing < split : landing > split;
    return me.slot === 0 ? behind : !behind;
  }
}
