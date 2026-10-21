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
  RUN_SPEED,
  bodyCenter,
  type CourtId,
  type Match,
  type Player,
} from "~/lib/games/volley/engine";

// Draws a match on a canvas, in the look of Powa Volley Classic: painted island and jungle
// scenery, glossy outlined blobs, a bamboo pole for a net and the white and yellow score boxes.
// Everything is in court units (800×450); the caller sets the scale.

/** A short tag over each player: "P1", "P2" or "CPU". */
export type PlayerTags = readonly string[];

const NAVY = "#1c2a6b";

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

/** Mixes two #rrggbb colours: 0 is `a`, 1 is `b`. */
function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t));
  return `rgb(${out.join(",")})`;
}

function vertical(ctx: CanvasRenderingContext2D, top: number, bottom: number, stops: string[]) {
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
  return gradient;
}

/** A closed shape through the points, with rounded corners. */
function blob(ctx: CanvasRenderingContext2D, points: [number, number][]) {
  ctx.beginPath();
  const mid = (i: number) => {
    const [ax, ay] = points[i % points.length]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    return [(ax + bx) / 2, (ay + by) / 2] as const;
  };
  const start = mid(0);
  ctx.moveTo(start[0], start[1]);
  for (let i = 1; i <= points.length; i++) {
    const [cx, cy] = points[i % points.length]!;
    const [mx, my] = mid(i);
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  ctx.closePath();
}

function rock(ctx: CanvasRenderingContext2D, points: [number, number][]) {
  blob(ctx, points);
  const ys = points.map(([, y]) => y);
  ctx.fillStyle = vertical(ctx, Math.min(...ys), Math.max(...ys), [
    "#e4e8e2",
    "#b3b9b2",
    "#8b928a",
  ]);
  ctx.fill();
  ctx.strokeStyle = "rgba(70,78,70,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function palm(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, lean: number) {
  const topX = x + lean;
  const topY = y - height;
  ctx.strokeStyle = "#7a4f24";
  ctx.lineWidth = height / 18;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + lean * 0.2, y - height * 0.5, topX, topY);
  ctx.stroke();
  for (const [angle, length] of [
    [-2.9, 1],
    [-2.3, 0.8],
    [-1.6, 0.55],
    [-0.8, 0.8],
    [-0.2, 1],
    [0.4, 0.75],
    [2.6, 0.75],
  ] as const) {
    const reach = height * 0.55 * length;
    const ex = topX + Math.cos(angle) * reach;
    const ey = topY + Math.sin(angle) * reach * 0.5 + reach * 0.25;
    ctx.fillStyle = angle < -1.2 ? "#3c9a2e" : "#58bf3d";
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.quadraticCurveTo((topX + ex) / 2, topY - reach * 0.35, ex, ey);
    ctx.quadraticCurveTo((topX + ex) / 2, topY - reach * 0.1, topX, topY + 3);
    ctx.fill();
  }
}

/** The grassy top and rock face of an island, with a fringe of leaves along its edge. */
function island(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  edge: number,
) {
  ctx.fillStyle = vertical(ctx, edge, edge + 34, ["#a3aaa0", "#7d857b"]);
  ctx.beginPath();
  ctx.moveTo(left, edge);
  ctx.lineTo(right, edge);
  ctx.quadraticCurveTo(right + 10, edge + 20, right - 10, edge + 34);
  ctx.lineTo(left, edge + 36);
  ctx.fill();
  ctx.fillStyle = vertical(ctx, top, edge, ["#9be04f", "#6cc237"]);
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.quadraticCurveTo((left + right) / 2, top - 6, right - 20, top + 4);
  ctx.quadraticCurveTo(right + 6, top + 10, right, edge);
  ctx.lineTo(left, edge);
  ctx.fill();
  for (let x = left; x < right; x += 9) {
    ctx.fillStyle = (x / 9) % 2 ? "#3f8f22" : "#5aae2c";
    ctx.beginPath();
    ctx.moveTo(x - 2, edge - 6);
    ctx.quadraticCurveTo(x + 6, edge - 2, x + 3 + ((x * 7) % 5), edge + 14 + ((x * 3) % 7));
    ctx.quadraticCurveTo(x + 2, edge + 2, x - 2, edge - 6);
    ctx.fill();
  }
}

function drawBeach(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = vertical(ctx, 0, 260, ["#3d7fd9", "#86c3ec", "#cdeff7"]);
  ctx.fillRect(0, 0, COURT_W, 260);
  // Cliffs at the back.
  rock(ctx, [
    [-20, 300],
    [-10, 70],
    [60, 40],
    [140, 60],
    [175, 150],
    [190, 290],
  ]);
  rock(ctx, [
    [600, 290],
    [620, 220],
    [690, 190],
    [770, 180],
    [820, 200],
    [820, 290],
  ]);
  // The sea between the islands.
  ctx.fillStyle = vertical(ctx, 240, 335, ["#7fd6e2", "#3aaac4", "#2a8db0"]);
  ctx.fillRect(0, 240, COURT_W, 95);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.5;
  for (let y = 252; y < 330; y += 11) {
    ctx.beginPath();
    for (let x = ((y * 13) % 40) - 40; x < COURT_W; x += 46) {
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 8, y - 3, x + 18, y);
    }
    ctx.stroke();
  }
  // A small palm on a far rock, then the islands.
  palm(ctx, 330, 262, 60, 10);
  island(ctx, -10, 370, 262, 300);
  island(ctx, 470, 810, 270, 304);
  palm(ctx, 560, 290, 150, 8);

  // The hut on stilts, with its orange cloth roof.
  ctx.strokeStyle = "#5b3410";
  ctx.lineWidth = 4;
  for (const x of [200, 228, 286]) {
    ctx.beginPath();
    ctx.moveTo(x, 236);
    ctx.lineTo(x + 2, 292);
    ctx.stroke();
  }
  ctx.fillStyle = "#8c5222";
  ctx.fillRect(182, 236, 130, 8);
  ctx.fillStyle = vertical(ctx, 130, 236, ["#b06b2c", "#8f5220"]);
  ctx.beginPath();
  ctx.moveTo(196, 236);
  ctx.lineTo(194, 150);
  ctx.lineTo(258, 120);
  ctx.lineTo(300, 150);
  ctx.lineTo(298, 236);
  ctx.fill();
  ctx.strokeStyle = "#6a3a14";
  ctx.lineWidth = 1.5;
  for (let y = 158; y < 236; y += 11) {
    ctx.beginPath();
    ctx.moveTo(196, y);
    ctx.lineTo(298, y + 2);
    ctx.stroke();
  }
  ctx.fillStyle = vertical(ctx, 100, 200, ["#f2b443", "#d98f26"]);
  ctx.beginPath();
  ctx.moveTo(258, 104);
  ctx.quadraticCurveTo(220, 140, 176, 196);
  ctx.quadraticCurveTo(196, 204, 218, 194);
  ctx.quadraticCurveTo(232, 204, 250, 192);
  ctx.lineTo(270, 140);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#6a3a14";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(258, 106);
  ctx.lineTo(250, 80);
  ctx.moveTo(262, 106);
  ctx.lineTo(272, 78);
  ctx.stroke();

  // Sand, with soft patches and the shadow of palm leaves.
  ctx.fillStyle = vertical(ctx, 330, COURT_H, ["#f3d466", "#e2b744", "#c99a2c"]);
  ctx.fillRect(0, 330, COURT_W, COURT_H - 330);
  ctx.fillStyle = "rgba(180,130,30,0.18)";
  for (const [x, y, w] of [
    [120, 360, 90],
    [520, 372, 130],
    [300, 425, 120],
    [700, 430, 80],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(x, y, w, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(70,50,10,0.16)";
  for (const [x, y, s] of [
    [60, 420, 1],
    [690, 385, -1],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.ellipse(x + s * i * 14, y - i * 3, 36, 5, s * (0.3 + i * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function trunk(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  bend: number,
  bottom: number,
) {
  ctx.fillStyle = "#e09a37";
  ctx.beginPath();
  ctx.moveTo(x - width / 2, bottom);
  ctx.quadraticCurveTo(x - width / 2 + bend, bottom / 2, x - width * 0.35, -10);
  ctx.lineTo(x + width * 0.35, -10);
  ctx.quadraticCurveTo(x + width / 2 + bend, bottom / 2, x + width / 2, bottom);
  ctx.fill();
  // Shaded right edge and a highlight down the left.
  ctx.strokeStyle = "#a9621f";
  ctx.lineWidth = width * 0.22;
  ctx.beginPath();
  ctx.moveTo(x + width * 0.38, bottom);
  ctx.quadraticCurveTo(x + width * 0.38 + bend, bottom / 2, x + width * 0.25, -10);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,226,140,0.7)";
  ctx.lineWidth = width * 0.12;
  ctx.beginPath();
  ctx.moveTo(x - width * 0.22, bottom);
  ctx.quadraticCurveTo(x - width * 0.22 + bend, bottom / 2, x - width * 0.18, -10);
  ctx.stroke();
}

function drawJungle(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = vertical(ctx, 0, 360, ["#5fcf9f", "#b9f5e2", "#e2fff6"]);
  ctx.fillRect(0, 0, COURT_W, 360);
  // Pale trees far back in the mist.
  ctx.fillStyle = "rgba(226,190,110,0.55)";
  for (let x = 14; x < COURT_W; x += 37) {
    const w = 8 + ((x * 7) % 9);
    ctx.fillRect(x, 60 + ((x * 5) % 40), w, 260);
  }
  // The canopy.
  for (const [x, y, rx, ry, color] of [
    [60, 40, 120, 70, "#2b8a3a"],
    [250, 20, 140, 80, "#1f7030"],
    [450, 50, 130, 70, "#2f9440"],
    [640, 25, 150, 85, "#1f7030"],
    [780, 70, 90, 60, "#2b8a3a"],
    [170, 110, 90, 40, "#3aa24a"],
    [560, 120, 100, 40, "#3aa24a"],
  ] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Big golden trunks.
  for (const [x, w, bend] of [
    [40, 34, 12],
    [175, 26, -10],
    [300, 22, 8],
    [520, 40, -6],
    [655, 24, 14],
    [760, 30, -12],
  ] as const) {
    trunk(ctx, x, w, bend, 330);
  }
  // Arching branches across the top, the highest one the monkey's roof.
  ctx.lineCap = "round";
  for (const [x1, x2, sag, width] of [
    [-40, 260, 70, 7],
    [180, 520, 90, 6],
    [430, 840, 80, 7],
    [90, 390, 40, 5],
    [560, 760, 45, 5],
  ] as const) {
    ctx.strokeStyle = "#b8681d";
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, 18);
    ctx.quadraticCurveTo((x1 + x2) / 2, 18 + sag * 2, x2, 18);
    ctx.stroke();
  }
  ctx.strokeStyle = "#a35a17";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(-10, 6);
  for (let x = 0; x <= COURT_W + 100; x += 100) ctx.quadraticCurveTo(x + 50, 12, x + 100, 5);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,210,130,0.6)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-10, 2);
  for (let x = 0; x <= COURT_W + 100; x += 100) ctx.quadraticCurveTo(x + 50, 8, x + 100, 1);
  ctx.stroke();

  // Rolling green hills.
  ctx.fillStyle = "#1d5a25";
  ctx.beginPath();
  ctx.moveTo(0, 345);
  ctx.quadraticCurveTo(120, 278, 260, 300);
  ctx.quadraticCurveTo(420, 268, 560, 296);
  ctx.quadraticCurveTo(700, 270, COURT_W, 290);
  ctx.lineTo(COURT_W, 345);
  ctx.fill();
  ctx.fillStyle = "rgba(130,200,80,0.75)";
  for (const [x, y, w] of [
    [110, 300, 50],
    [330, 292, 70],
    [480, 300, 40],
    [690, 290, 60],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(x, y, w, 8, -0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dirt floor with patches of sunlight.
  ctx.fillStyle = vertical(ctx, 330, COURT_H, ["#a8672a", "#8a5220", "#6b3d14"]);
  ctx.beginPath();
  ctx.moveTo(0, 340);
  ctx.quadraticCurveTo(400, 318, COURT_W, 338);
  ctx.lineTo(COURT_W, COURT_H);
  ctx.lineTo(0, COURT_H);
  ctx.fill();
  ctx.fillStyle = "rgba(240,180,70,0.6)";
  for (const [x1, x2, y1, y2] of [
    [40, 260, 352, 440],
    [460, 600, 340, 400],
    [620, 790, 410, 450],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x1, y2);
    ctx.lineTo(x1 + 40, y1);
    ctx.lineTo(x2, y1 + 4);
    ctx.lineTo(x2 - 50, y2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(60,30,8,0.25)";
  ctx.lineWidth = 2;
  for (let y = 360; y < COURT_H; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= COURT_W; x += 80) ctx.quadraticCurveTo(x + 40, y - 5, x + 80, y);
    ctx.stroke();
  }
}

/** The bamboo pole, and the net's shadow on the ground. */
function drawNet(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.strokeStyle = "rgba(60,40,10,0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    ctx.moveTo(NET_X + i * 3, GROUND_Y - 6 + i * 4);
    ctx.lineTo(NET_X + 36 + i * 3, GROUND_Y - 6 + i * 4);
    ctx.moveTo(NET_X + i * 4.5, GROUND_Y - 6);
    ctx.lineTo(NET_X + 24 + i * 4.5, GROUND_Y + 26);
  }
  ctx.stroke();
  ctx.restore();

  const left = NET_X - NET_HALF_W;
  const width = NET_HALF_W * 2;
  const pole = ctx.createLinearGradient(left, 0, left + width, 0);
  pole.addColorStop(0, "#c9b994");
  pole.addColorStop(0.35, "#f3ead2");
  pole.addColorStop(1, "#a8987a");
  ctx.fillStyle = pole;
  ctx.beginPath();
  ctx.roundRect(left, NET_TOP - 4, width, GROUND_Y - NET_TOP + 8, [4, 4, 0, 0]);
  ctx.fill();
  ctx.strokeStyle = "#9a8a68";
  ctx.lineWidth = 1.5;
  for (let y = NET_TOP + 26; y < GROUND_Y; y += 34) {
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
  }
}

function drawShadow(ctx: CanvasRenderingContext2D, x: number, height: number, width: number) {
  const fade = Math.max(0.15, 1 - height / 400);
  ctx.fillStyle = `rgba(40,25,0,${0.3 * fade})`;
  ctx.beginPath();
  ctx.ellipse(x, GROUND_Y + 2, width * fade, 6 * fade, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A glossy blob with a black outline and two dot eyes, as in the original. */
function drawPlayer(ctx: CanvasRenderingContext2D, match: Match, player: Player, tag: string) {
  const { character } = player;
  const center = bodyCenter(player);
  drawShadow(ctx, player.x, GROUND_Y - player.y, PLAYER_R);

  // Squash for a moment after a touch, stretch while rising, lean into a run.
  const squash =
    player.sinceTouch < 0.12 ? 1 - Math.sin((player.sinceTouch / 0.12) * Math.PI) * 0.12 : 1;
  const stretch = player.onGround ? 1 : 1 + Math.min(0.08, Math.abs(player.vy) / 9000);
  const height = PLAYER_R * 2 * squash * stretch;
  const half = (PLAYER_R * 0.9) / Math.sqrt(squash * stretch);
  const lean = (player.vx / RUN_SPEED) * 0.1;

  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(lean);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(half * 1.12, 0, half * 1.02, -height * 0.6, half * 0.72, -height * 0.86);
  ctx.bezierCurveTo(
    half * 0.45,
    -height * 1.03,
    -half * 0.45,
    -height * 1.03,
    -half * 0.72,
    -height * 0.86,
  );
  ctx.bezierCurveTo(-half * 1.02, -height * 0.6, -half * 1.12, 0, 0, 0);
  ctx.closePath();
  const gloss = ctx.createRadialGradient(
    -half * 0.3,
    -height * 0.68,
    2,
    0,
    -height * 0.45,
    height * 0.7,
  );
  gloss.addColorStop(0, mix(character.color, "#ffffff", 0.45));
  gloss.addColorStop(0.35, character.color);
  gloss.addColorStop(1, mix(character.color, "#000000", 0.45));
  ctx.fillStyle = gloss;
  ctx.fill();
  ctx.strokeStyle = "#0b0b0b";
  ctx.lineWidth = 3;
  ctx.stroke();
  // Two dot eyes near the top, looking towards the ball.
  const look = Math.sign(match.ball.x - center.x) || (player.side === 0 ? 1 : -1);
  const up = Math.max(-2, Math.min(2, (match.ball.y - center.y) / 60));
  ctx.fillStyle = "#0b0b0b";
  for (const offset of [-5, 5]) {
    ctx.beginPath();
    ctx.ellipse(look * 7 + offset, -height * 0.8 + up, 2.6, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.font = "800 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeText(tag, player.x, player.y - height - 10);
  ctx.fillStyle = "#fff";
  ctx.fillText(tag, player.x, player.y - height - 10);
}

/** A white leather volleyball with grey seams and a faint trail. */
function drawBall(ctx: CanvasRenderingContext2D, match: Match) {
  const { ball } = match;
  drawShadow(ctx, ball.x, GROUND_Y - ball.y, BALL_R);
  if (ball.y < -BALL_R) {
    // Off the top: a marker at the edge shows where it is.
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.strokeStyle = NAVY;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ball.x, 4);
    ctx.lineTo(ball.x - 8, 16);
    ctx.lineTo(ball.x + 8, 16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 300) {
    for (let i = 1; i <= 4; i++) {
      ctx.fillStyle = `rgba(235,235,230,${0.16 - i * 0.03})`;
      ctx.beginPath();
      ctx.arc(
        ball.x - ball.vx * 0.012 * i,
        ball.y - ball.vy * 0.012 * i,
        BALL_R * (1 - i * 0.1),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.save();
  ctx.translate(ball.x, ball.y);
  const shade = ctx.createRadialGradient(-5, -6, 1, 0, 0, BALL_R);
  shade.addColorStop(0, "#ffffff");
  shade.addColorStop(0.6, "#e6e6e0");
  shade.addColorStop(1, "#a9a9a2");
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.rotate(ball.angle);
  ctx.strokeStyle = "#7c7c76";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    for (const offset of [0, 6]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(
        BALL_R * 0.6 + offset,
        -BALL_R * 0.2,
        BALL_R * 0.9 + offset,
        BALL_R * 0.7,
      );
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = "#5e5e58";
  ctx.lineWidth = 1.5;
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
  for (const side of [-1, 1]) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(x + dir * 3 + side * 5.5, y - 2, 4.5, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1c1917";
    ctx.beginPath();
    ctx.arc(x + dir * 4.5 + side * 5.5, y - 1, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#1c1917";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (holding) ctx.arc(x + dir * 3, y + 7, 4, Math.PI + 0.3, -0.3);
  else ctx.arc(x + dir * 3, y + 5, 4, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

/** The score: a white box for the left side, a yellow one for the right, a ball over the server's. */
function drawHud(ctx: CanvasRenderingContext2D, match: Match) {
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = "900 28px system-ui, sans-serif";
  for (const side of [0, 1] as const) {
    const text = String(match.score[side]);
    const width = 14 + text.length * 17;
    const x = side === 0 ? NET_X - 38 : NET_X + 38;
    // The ball over the box: white over the serving side's score, dull grey over the other.
    const serving = match.serving === side;
    const sphere = ctx.createRadialGradient(x - 3, 17, 1, x, 20, 8);
    sphere.addColorStop(0, serving ? "#ffffff" : "#b9b9b9");
    sphere.addColorStop(1, serving ? "#c8c8c2" : "#5d5d5d");
    ctx.fillStyle = sphere;
    ctx.beginPath();
    ctx.arc(x, 20, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = side === 0 ? "#f3f5ff" : "#f2c418";
    ctx.strokeStyle = NAVY;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, 34, width, 38, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = NAVY;
    ctx.fillText(text, x, 54);
  }
  ctx.textBaseline = "alphabetic";

  // Touches used by the side that has the ball.
  const { ball } = match;
  if (ball.live && ball.lastSide !== null && match.phase.kind === "rally") {
    const allowed = ball.serving ? 1 : MAX_TOUCHES;
    const left = ball.lastSide === 0;
    for (let i = 0; i < allowed; i++) {
      const x = left
        ? NET_X - 38 - (allowed - 1) * 6 + i * 12
        : NET_X + 38 - (allowed - 1) * 6 + i * 12;
      ctx.fillStyle = i < ball.touches ? NAVY : "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.arc(x, 84, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, text: string) {
  ctx.font = "900 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.lineWidth = 8;
  ctx.strokeStyle = NAVY;
  ctx.strokeText(text, NET_X, 170);
  ctx.fillStyle = "#ffd23f";
  ctx.fillText(text, NET_X, 170);
}

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
    drawBanner(ctx, banner);
  } else if (match.phase.kind === "serve" && match.phase.time < 1.2) {
    drawBanner(ctx, `${names[match.serving]} to serve`);
  }
}
