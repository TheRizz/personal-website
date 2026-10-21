import { describe, expect, it } from "vitest";
import { CpuPlayer } from "./ai";
import { CHARACTERS } from "./characters";
import {
  BALL_R,
  GROUND_Y,
  NET_X,
  MONKEY_Y,
  NO_INPUT,
  PLAYER_R,
  bodyCenter,
  createMatch,
  otherSide,
  playerBounds,
  serverOf,
  step,
  winnerOf,
  type GameEvent,
  type Match,
  type Side,
} from "./engine";

function newMatch(players: 2 | 4 = 2, court: "beach" | "jungle" = "beach", serving: Side = 0) {
  const match = createMatch({ characters: [...CHARACTERS.slice(0, players)], target: 11, court });
  match.serving = serving;
  match.ball.x = serverOf(match).x;
  return match;
}

/** Steps with nobody pressing anything until `until` returns true; returns every event. */
function run(match: Match, until: (events: GameEvent[]) => unknown, seconds = 10) {
  const all: GameEvent[] = [];
  for (let t = 0; t < seconds; t += 1 / 120) {
    const events = step(
      match,
      match.players.map(() => NO_INPUT),
    );
    all.push(...events);
    if (until(events)) break;
  }
  return all;
}

/** Puts the ball in play, falling from (x, y), as if `side` had touched it `touches` times. */
function inPlay(match: Match, x: number, y: number, side: Side, touches = 1) {
  Object.assign(match.ball, {
    x,
    y,
    vx: 0,
    vy: 0,
    live: true,
    serving: false,
    lastSide: side,
    touches,
  });
  match.phase = { kind: "rally" };
}

const rallyOver = (events: GameEvent[]) => events.find((event) => event.type === "rally-over");

describe("side-out scoring", () => {
  it("gives the serving side a point when the ball lands on the other half", () => {
    const match = newMatch(2, "beach", 0);
    inPlay(match, 700, 100, 0);
    const end = rallyOver(run(match, rallyOver));
    expect(end).toMatchObject({ winner: 0, scored: true });
    expect(match.score).toEqual([1, 0]);
    expect(match.serving).toBe(0);
  });

  it("passes the serve without a point when the receiving side wins the rally", () => {
    const match = newMatch(2, "beach", 0);
    inPlay(match, 100, 100, 1);
    const end = rallyOver(run(match, rallyOver));
    expect(end).toMatchObject({ winner: 1, scored: false });
    expect(match.score).toEqual([0, 0]);
    expect(match.serving).toBe(1);
  });

  it("rotates the server in 2v2 when a team wins the serve back", () => {
    const match = newMatch(4, "beach", 0);
    expect(serverOf(match).slot).toBe(0);
    inPlay(match, 100, 100, 1);
    run(match, rallyOver);
    expect(match.serving).toBe(1);
    expect(match.nextServer).toEqual([0, 1]);
  });

  it("needs a two-point lead to win", () => {
    expect(winnerOf([11, 10], 11)).toBeNull();
    expect(winnerOf([11, 9], 11)).toBe(0);
    expect(winnerOf([13, 15], 11)).toBe(1);
  });

  it("ends the match after the point pause once a side has won", () => {
    const match = newMatch(2, "beach", 0);
    match.score = [10, 3];
    inPlay(match, 700, 100, 0);
    const events = run(match, (batch) => batch.some((event) => event.type === "win"));
    expect(events).toContainEqual({ type: "win", winner: 0 });
    expect(match.phase).toEqual({ kind: "over", winner: 0 });
  });
});

describe("touches", () => {
  it("keeps the serve still above the server until it is touched", () => {
    const match = newMatch(2, "beach", 1);
    const before = { ...match.ball };
    run(match, () => false, 2);
    expect(match.ball).toMatchObject({ x: before.x, y: before.y, live: false });
  });

  it("is a fault when the server touches the serve twice", () => {
    const match = newMatch(2, "beach", 0);
    const server = match.players[0]!;
    // Two touches straight up from the server's head, without the ball crossing the net.
    const center = bodyCenter(server);
    Object.assign(match.ball, { x: center.x, y: center.y - PLAYER_R - BALL_R + 2 });
    const events = run(match, rallyOver);
    expect(rallyOver(events)).toMatchObject({ winner: 1, reason: "serve", scored: false });
  });

  it("is a fault on the fourth touch in a row", () => {
    const match = newMatch(2, "beach", 1);
    const player = match.players[0]!;
    inPlay(match, player.x, 200, 0, 3);
    const events = run(match, rallyOver);
    expect(rallyOver(events)).toMatchObject({ winner: 1, reason: "touches", scored: true });
  });

  it("counts one contact once however long the ball rests on the body", () => {
    const match = newMatch(2, "beach", 1);
    const player = match.players[0]!;
    inPlay(match, player.x, 200, 1);
    const events = run(match, (batch) => batch.some((event) => event.type === "touch"));
    expect(events.filter((event) => event.type === "touch")).toHaveLength(1);
    expect(match.ball.touches).toBe(1);
  });
});

describe("the court", () => {
  it("keeps players on their own half", () => {
    const match = newMatch();
    for (let i = 0; i < 240; i++) {
      step(match, [
        { ...NO_INPUT, right: true },
        { ...NO_INPUT, left: true },
      ]);
    }
    expect(match.players[0]!.x).toBe(playerBounds(0)[1]);
    expect(match.players[1]!.x).toBe(playerBounds(1)[0]);
    expect(match.players[0]!.x).toBeLessThan(NET_X);
  });

  it("bounces the ball off the net back to the side it came from", () => {
    const match = newMatch(2, "beach", 1);
    inPlay(match, NET_X - 120, GROUND_Y - 60, 0);
    match.ball.vx = 600;
    match.ball.vy = -100;
    const events = run(match, rallyOver);
    expect(events).toContainEqual({ type: "net" });
    expect(match.ball.x).toBeLessThan(NET_X);
  });

  it("sends a monkey across the top of the jungle court only", () => {
    for (const court of ["beach", "jungle"] as const) {
      const match = newMatch(2, court, 0);
      inPlay(match, 200, -5000, 0);
      match.ball.vy = -2000;
      const events = run(match, (batch) => batch.some((e) => e.type === "monkey-arrives"), 15);
      const arrived = events.some((event) => event.type === "monkey-arrives");
      expect(arrived).toBe(court === "jungle");
    }
  });

  it.each([0, 1] as const)(
    "has the monkey catch a ball side %i passes him and spike it at the other side",
    (passer) => {
      const match = newMatch(2, "jungle", 0);
      match.monkey = { x: 300, y: MONKEY_Y, dir: 1, time: 0, holding: null, target: 0, rest: 0 };
      inPlay(match, 300, MONKEY_Y + 60, passer, 2);
      match.ball.vy = -400;
      const events = run(match, (batch) => batch.some((e) => e.type === "monkey-spike"), 2);
      expect(events).toContainEqual({ type: "monkey-catch" });
      expect(events).toContainEqual({ type: "monkey-spike", target: otherSide(passer) });
      // The receiving side starts afresh with three touches.
      expect(match.ball).toMatchObject({ lastSide: passer, touches: 0 });

      // Aimed at the player on the target side.
      const victim = match.players[otherSide(passer)]!;
      const before = Math.abs(match.ball.x - victim.x);
      for (let i = 0; i < 20; i++) step(match, [NO_INPUT, NO_INPUT]);
      expect(Math.abs(match.ball.x - victim.x)).toBeLessThan(before);
      expect(match.ball.vy).toBeGreaterThan(0);
    },
  );
});

describe("the computer player", () => {
  it.each(["easy", "normal", "hard"] as const)(
    "on %s serves over the net and beats a player who stands still",
    (level) => {
      const match = createMatch({
        characters: [...CHARACTERS.slice(0, 2)],
        target: 7,
        court: "beach",
        seed: 9,
      });
      const cpu = new CpuPlayer(1, level, 5);
      for (let i = 0; i < 120 * 300 && match.phase.kind !== "over"; i++) {
        step(match, [NO_INPUT, cpu.input(match)]);
      }
      expect(match.phase).toEqual({ kind: "over", winner: 1 });
      expect(match.score[0]).toBe(0);
    },
  );
});
