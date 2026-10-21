import {
  BALL_R,
  COURT_H,
  COURT_W,
  GROUND_Y,
  MAX_TOUCHES,
  MONKEY_R,
  MONKEY_Y,
  NET_HALF_W,
  NET_TOP,
  NET_X,
  PLAYER_R,
  bodyCenter,
  type CourtId,
  type Match,
  type Player,
} from "~/lib/games/volley/engine";

// Draws a match on a canvas. Everything is in court units (800×450); the caller sets the scale.

/** A short tag over each player: "P1", "P2" or "CPU". */
export type PlayerTags = readonly string[];

const backgrounds = new Map<string, HTMLCanvasElement>();

/** The court's scenery, drawn once per court and size and then copied each frame. */
function background(court: CourtId, scale: number): HTMLCanvasElement {
  const key = `${court}:${scale}`;
  const cached = backgrounds.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(COURT_W * scale);
  canvas.height = Math.round(COURT_H * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  if (court === "beach") drawBeach(ctx);
  else drawJungle(ctx);
  backgrounds.clear();
  backgrounds.set(key, canvas);
  return canvas;
}

function drawBeach(ctx: CanvasRenderingContext2D) {
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#38bdf8");
  sky.addColorStop(1, "#e0f7ff");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, COURT_W, GROUND_Y);
  // Sun.
  ctx.fillStyle = "#fff7c2";
  ctx.beginPath();
  ctx.arc(680, 70, 38, 0, Math.PI * 2);
  ctx.fill();
  // Clouds.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  for (const [x, y, s] of [
    [120, 70, 1],
    [330, 45, 0.7],
    [540, 110, 0.8],
  ] as const) {
    for (const [dx, dy, rx, ry] of [
      [0, 0, 42, 14],
      [26, -9, 26, 14],
      [-22, -5, 20, 11],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Sea.
  const sea = ctx.createLinearGradient(0, 300, 0, GROUND_Y);
  sea.addColorStop(0, "#0ea5e9");
  sea.addColorStop(1, "#7dd3fc");
  ctx.fillStyle = sea;
  ctx.fillRect(0, 300, COURT_W, GROUND_Y - 300);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  for (let y = 318; y < GROUND_Y - 10; y += 26) {
    ctx.beginPath();
    for (let x = 0; x <= COURT_W; x += 40) {
      ctx.moveTo(x + (y % 52), y);
      ctx.lineTo(x + 18 + (y % 52), y);
    }
    ctx.stroke();
  }
  // Palm tree on the left.
  ctx.strokeStyle = "#92400e";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(40, GROUND_Y);
  ctx.quadraticCurveTo(30, 260, 62, 190);
  ctx.stroke();
  ctx.fillStyle = "#15803d";
  for (const angle of [-2.6, -2, -1.2, -0.5, 0.2]) {
    ctx.beginPath();
    ctx.ellipse(
      62 + Math.cos(angle) * 34,
      190 + Math.sin(angle) * 16,
      40,
      9,
      angle,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  sand(ctx, "#fcd98b", "#e9b85a");
}

function drawJungle(ctx: CanvasRenderingContext2D) {
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#065f46");
  sky.addColorStop(1, "#a7f3d0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, COURT_W, GROUND_Y);
  // Layers of leaves at the back.
  for (const [color, base, size] of [
    ["#047857", 300, 70],
    ["#065f46", 345, 55],
  ] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    for (let x = 0; x <= COURT_W + 60; x += 60) {
      ctx.quadraticCurveTo(x + 30, base - size, x + 60, base + ((x / 60) % 2) * 12);
    }
    ctx.lineTo(COURT_W, GROUND_Y);
    ctx.fill();
  }
  // Tree trunks at the edges.
  ctx.fillStyle = "#713f12";
  ctx.fillRect(4, 0, 22, GROUND_Y);
  ctx.fillRect(COURT_W - 26, 0, 22, GROUND_Y);
  // The canopy and its hanging vines along the top.
  ctx.fillStyle = "#14532d";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let x = 0; x <= COURT_W; x += 50) ctx.quadraticCurveTo(x + 25, 46, x + 50, 18);
  ctx.lineTo(COURT_W, 0);
  ctx.fill();
  ctx.strokeStyle = "#166534";
  ctx.lineWidth = 3;
  for (let x = 30; x < COURT_W; x += 70) {
    ctx.beginPath();
    ctx.moveTo(x, 20);
    ctx.quadraticCurveTo(x + 8, 60, x - 4, 70 + ((x * 7) % 50));
    ctx.stroke();
  }
  // The bamboo roof beam the monkey walks along.
  ctx.fillStyle = "#a3a33a";
  ctx.fillRect(0, 0, COURT_W, 12);
  ctx.fillStyle = "#6b6b1f";
  ctx.fillRect(0, 10, COURT_W, 3);
  for (let x = 40; x < COURT_W; x += 80) ctx.fillRect(x, 0, 3, 12);
  sand(ctx, "#a16207", "#854d0e");
}

function sand(ctx: CanvasRenderingContext2D, top: string, bottom: string) {
  const ground = ctx.createLinearGradient(0, GROUND_Y, 0, COURT_H);
  ground.addColorStop(0, top);
  ground.addColorStop(1, bottom);
  ctx.fillStyle = ground;
  ctx.fillRect(0, GROUND_Y, COURT_W, COURT_H - GROUND_Y);
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 1.5);
  ctx.lineTo(COURT_W, GROUND_Y + 1.5);
  ctx.stroke();
}

function drawNet(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#334155";
  ctx.fillRect(NET_X - 3, NET_TOP, 6, GROUND_Y - NET_TOP);
  // Mesh on the upper part.
  const meshBottom = NET_TOP + 70;
  ctx.strokeStyle = "rgba(15,23,42,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = NET_TOP + 8; y <= meshBottom; y += 9) {
    ctx.moveTo(NET_X - NET_HALF_W - 3, y);
    ctx.lineTo(NET_X + NET_HALF_W + 3, y);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(15,23,42,0.18)";
  ctx.fillRect(NET_X - NET_HALF_W - 3, NET_TOP, (NET_HALF_W + 3) * 2, meshBottom - NET_TOP);
  // The tape.
  ctx.fillStyle = "#f8fafc";
  ctx.beginPath();
  ctx.roundRect(NET_X - NET_HALF_W - 4, NET_TOP - 4, (NET_HALF_W + 4) * 2, 9, 4);
  ctx.fill();
}

function drawShadow(ctx: CanvasRenderingContext2D, x: number, height: number, width: number) {
  const fade = Math.max(0.15, 1 - height / 400);
  ctx.fillStyle = `rgba(0,0,0,${0.22 * fade})`;
  ctx.beginPath();
  ctx.ellipse(x, GROUND_Y + 4, width * fade, 5 * fade, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayer(ctx: CanvasRenderingContext2D, match: Match, player: Player, tag: string) {
  const { character } = player;
  const center = bodyCenter(player);
  drawShadow(ctx, player.x, GROUND_Y - player.y, PLAYER_R * 0.9);

  // Squash for a moment after a touch, and stretch while rising.
  const squash =
    player.sinceTouch < 0.12 ? 1 - Math.sin((player.sinceTouch / 0.12) * Math.PI) * 0.12 : 1;
  const stretch = player.onGround ? 1 : 1 + Math.min(0.08, Math.abs(player.vy) / 9000);
  const rx = PLAYER_R / Math.sqrt(squash * stretch);
  const ry = PLAYER_R * squash * stretch;

  ctx.save();
  ctx.translate(center.x, player.y - ry);
  // Feet.
  ctx.fillStyle = character.shade;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * 15, ry - 2, 11, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Body.
  ctx.fillStyle = character.color;
  ctx.strokeStyle = character.shade;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Belly and shine.
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.beginPath();
  ctx.ellipse(0, ry * 0.35, rx * 0.6, ry * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.ellipse(-rx * 0.45, -ry * 0.5, 6, 9, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // Eyes that follow the ball.
  const lookX = match.ball.x - center.x;
  const lookY = match.ball.y - center.y;
  const look = Math.hypot(lookX, lookY) || 1;
  for (const side of [-1, 1]) {
    const ex = side * 11;
    const ey = -ry * 0.28;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(ex, ey, 7.5, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(ex + (lookX / look) * 3.5, ey + (lookY / look) * 4, 3.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Tag.
  ctx.font = "700 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(15,23,42,0.55)";
  ctx.fillText(tag, player.x, player.y - ry * 2 - 8);
}

function drawBall(ctx: CanvasRenderingContext2D, match: Match) {
  const { ball } = match;
  drawShadow(ctx, ball.x, GROUND_Y - ball.y, BALL_R);
  if (ball.y < -BALL_R) {
    // Off the top: a marker at the edge shows where it is.
    ctx.fillStyle = "rgba(15,23,42,0.6)";
    ctx.beginPath();
    ctx.moveTo(ball.x, 4);
    ctx.lineTo(ball.x - 8, 16);
    ctx.lineTo(ball.x + 8, 16);
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(ball.angle);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Volleyball panels.
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.arc(-BALL_R * 1.1, -BALL_R * 0.4, BALL_R, -0.9, 1.2);
  ctx.arc(-BALL_R * 0.2, 0, BALL_R * 0.55, 1.6, -1.4, true);
  ctx.fill();
  ctx.fillStyle = "#3b82f6";
  ctx.beginPath();
  ctx.arc(BALL_R * 0.9, BALL_R * 0.9, BALL_R, 3.2, 4.9);
  ctx.arc(BALL_R * 0.25, BALL_R * 0.3, BALL_R * 0.5, 4.6, 2.9, true);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawMonkey(ctx: CanvasRenderingContext2D, match: Match) {
  const monkey = match.monkey;
  if (!monkey) return;
  const { x, y, dir } = monkey;
  const holding = monkey.holding !== null;
  const swing = Math.sin(monkey.time * 9);
  ctx.lineCap = "round";
  // Tail.
  ctx.strokeStyle = "#78350f";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x - dir * 14, y + 14);
  ctx.quadraticCurveTo(x - dir * 40, y + 24, x - dir * 36, y + 2 + Math.sin(monkey.time * 6) * 4);
  ctx.stroke();
  // Arms: hand over hand along the roof beam, or down around a caught ball.
  ctx.lineWidth = 6;
  ctx.beginPath();
  if (holding) {
    for (const side of [-1, 1]) {
      ctx.moveTo(x + side * 12, y + 4);
      ctx.lineTo(x + side * 16 + dir * 4, y + MONKEY_R + 6);
    }
  } else {
    ctx.moveTo(x - 8, y - 8);
    ctx.lineTo(x - 12 + swing * 8, MONKEY_Y - MONKEY_R - 14);
    ctx.moveTo(x + 8, y - 8);
    ctx.lineTo(x + 12 - swing * 8, MONKEY_Y - MONKEY_R - 14);
  }
  ctx.stroke();
  // Legs dangling.
  ctx.beginPath();
  ctx.moveTo(x - 7, y + 16);
  ctx.lineTo(x - 9 - swing * 3, y + 30);
  ctx.moveTo(x + 7, y + 16);
  ctx.lineTo(x + 9 + swing * 3, y + 30);
  ctx.stroke();
  // Ears, head-body and face.
  ctx.fillStyle = "#92400e";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + side * 19, y - 4, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, MONKEY_R - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fcd9a8";
  ctx.beginPath();
  ctx.ellipse(x + dir * 3, y + 3, 13, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1c1917";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 3 + side * 5, y - 1, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#1c1917";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (holding) ctx.arc(x + dir * 3, y + 7, 4, Math.PI + 0.3, -0.3);
  else ctx.arc(x + dir * 3, y + 5, 4, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

function teamColor(match: Match, side: 0 | 1) {
  return match.players.find((player) => player.side === side)!.character.shade;
}

function drawHud(ctx: CanvasRenderingContext2D, match: Match) {
  ctx.textBaseline = "alphabetic";
  ctx.font = "800 44px system-ui, sans-serif";
  for (const side of [0, 1] as const) {
    const x = side === 0 ? NET_X - 48 : NET_X + 48;
    ctx.textAlign = side === 0 ? "right" : "left";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.strokeText(String(match.score[side]), x, 58);
    ctx.fillStyle = teamColor(match, side);
    ctx.fillText(String(match.score[side]), x, 58);
  }
  // A small ball beside the score of the side that's serving.
  const serveX = match.serving === 0 ? NET_X - 22 : NET_X + 22;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(serveX, 44, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Touches used by the side that has the ball.
  const { ball } = match;
  if (ball.live && ball.lastSide !== null && match.phase.kind === "rally") {
    const allowed = ball.serving ? 1 : MAX_TOUCHES;
    const left = ball.lastSide === 0;
    for (let i = 0; i < allowed; i++) {
      const x = left ? NET_X - 60 - i * 16 : NET_X + 60 + i * 16;
      ctx.fillStyle = i < ball.touches ? teamColor(match, ball.lastSide) : "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(x, 78, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string) {
  ctx.font = "800 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(text, NET_X, 170);
  ctx.fillStyle = color;
  ctx.fillText(text, NET_X, 170);
}

/** The words shown over the court when a rally ends. */
export function rallyBanner(match: Match, names: readonly [string, string]): string | null {
  const phase = match.phase;
  if (phase.kind !== "point") return null;
  const name = names[phase.winner];
  if (phase.reason === "touches")
    return phase.scored ? `Too many touches! ${name} scores` : `Too many touches! Side out`;
  if (phase.reason === "serve") return "Serve fault! Side out";
  return phase.scored ? `${name} scores!` : "Side out!";
}

export function drawMatch(
  ctx: CanvasRenderingContext2D,
  match: Match,
  scale: number,
  tags: PlayerTags,
  names: readonly [string, string],
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(background(match.court, scale), 0, 0);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawNet(ctx);
  match.players.forEach((player, index) => drawPlayer(ctx, match, player, tags[index] ?? ""));
  drawMonkey(ctx, match);
  drawBall(ctx, match);
  drawHud(ctx, match);
  const banner = rallyBanner(match, names);
  if (banner && match.phase.kind === "point") {
    drawBanner(ctx, banner, teamColor(match, match.phase.winner));
  } else if (match.phase.kind === "serve" && match.phase.time < 1.2) {
    drawBanner(ctx, `${names[match.serving]} to serve`, teamColor(match, match.serving));
  }
}
