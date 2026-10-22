import {
  ACHIEVEMENTS,
  AP_BONUS,
  ENDING_UPGRADE,
  GENERATORS,
  availableUpgrades,
  baseRate,
  clickValue,
  currentRate,
  formatDuration,
  formatShort,
  generatorCost,
  migrationGain,
  nextPointAt,
  overclocked,
  tierRate,
  upcomingGolden,
  type GameState,
  type Status,
  type Upgrade,
} from "@site/tycoon-core";
import { Canvas, type Style } from "./screen";

// One frame of the terminal game: the same schematic as the web scene (tiers around a core,
// packets flowing in), the shop beside it, and the key help underneath. A pure function of the
// view, so it can be tested without a terminal.

export const MIN_COLS = 80;
export const MIN_ROWS = 24;

/** The web scene's neon palette, cheapest tier first. */
const TIER_HEX = [
  "#22d3ee",
  "#34d399",
  "#a3e635",
  "#facc15",
  "#fb923c",
  "#f472b6",
  "#c084fc",
  "#818cf8",
  "#60a5fa",
  "#e2e8f0",
];
const LABELS = ["CSV", "CRON", "SFTP", "REST", "MQ", "ETL", "LAKE", "MESH", "SAT", "GRID"];

const S = {
  text: { fg: "#e4e4e7" },
  muted: { fg: "#8b8b94" },
  dim: { fg: "#52525b" },
  core: { fg: "#22d3ee", bold: true },
  overclock: { fg: "#f472b6", bold: true },
  gold: { fg: "#fbbf24", bold: true },
  good: { fg: "#a5f3fc" },
  warn: { fg: "#fcd34d" },
  violet: { fg: "#c4b5fd" },
  title: { fg: "#22d3ee", bold: true },
} satisfies Record<string, Style>;

const tierStyle = (tier: number, dim = false): Style => ({ fg: TIER_HEX[tier] ?? "#22d3ee", dim });

export type Tab = "build" | "upgrades" | "migrate" | "stats";
export const TABS: Tab[] = ["build", "upgrades", "migrate", "stats"];
const TAB_NAMES: Record<Tab, string> = {
  build: "Build",
  upgrades: "Upgrades",
  migrate: "Migrate",
  stats: "Stats",
};

/** Keys that pick an upgrade on the Upgrades tab (letters that aren't commands). */
export const UPGRADE_KEYS = "abcdefhijklnoprtuvwyz";

export interface View {
  cols: number;
  rows: number;
  /** ms, for animation only. */
  time: number;
  state: GameState | null;
  status: Status;
  tab: Tab;
  buyAmount: number;
  toast: string | null;
  saving: boolean;
  lastSavedAt: number | null;
  confirmMigrate: boolean;
  pairing: { code: string; until: number } | null;
  serverLabel: string;
}

/** Upgrades in the order the Upgrades tab lists them (the keys follow this order). */
export function listedUpgrades(state: GameState): Upgrade[] {
  return availableUpgrades(state)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, UPGRADE_KEYS.length);
}

function center(text: string, width: number): string {
  const pad = Math.max(0, width - text.length);
  return " ".repeat(Math.floor(pad / 2)) + text + " ".repeat(pad - Math.floor(pad / 2));
}

/** Cells of a straight line, Bresenham style. */
function line(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const cells: [number, number][] = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - x);
  const dy = -Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push([x, y]);
    if (x === tx && y === ty) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

function drawScene(
  c: Canvas,
  view: View,
  state: GameState,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  const cx = x0 + Math.floor(w / 2);
  const cy = y0 + Math.floor(h / 2);
  const boosted = overclocked(state);
  const coreStyle = boosted ? S.overclock : S.core;
  const coreW = 13;
  const coreH = 4;
  const left = cx - Math.floor(coreW / 2);
  const top = cy - Math.floor(coreH / 2);
  const insideCore = (x: number, y: number) =>
    x >= left - 1 && x < left + coreW + 1 && y >= top && y < top + coreH;

  // A faint grid, like the web scene's.
  for (let y = y0 + 1; y < y0 + h; y += 4) {
    for (let x = x0 + 4; x < x0 + w - 1; x += 10) c.put(x, y, "+", S.dim);
  }

  const rx = Math.max(10, w / 2 - 7);
  const ry = Math.max(4, h / 2 - 2);
  GENERATORS.forEach((_, tier) => {
    const owned = state.owned[tier] ?? 0;
    if (owned === 0) return;
    const angle = -Math.PI * 0.85 + (tier / GENERATORS.length) * Math.PI * 2;
    const nx = cx + Math.cos(angle) * rx;
    const ny = cy + Math.sin(angle) * ry;
    const path = line(nx, ny, cx, cy).filter(([x, y], i) => i > 0 && !insideCore(x, y));
    // Terminal cells are about twice as tall as wide, so slopes are judged with that in mind.
    const dx = cx - nx;
    const dy = (cy - ny) * 2;
    const glyph =
      Math.abs(dx) > Math.abs(dy) * 2.4
        ? "─"
        : Math.abs(dy) > Math.abs(dx) * 2.4
          ? "│"
          : dx * dy > 0
            ? "╲"
            : "╱";
    for (const [x, y] of path) {
      const under = c.get(x, y);
      if (under === " " || under === "+") c.put(x, y, glyph, tierStyle(tier, true));
    }
    // Packets: more of them, faster, as the tier produces more (log scale, like the web).
    const rate = tierRate(state, tier) * (boosted ? 7 : 1);
    const count = Math.min(5, 1 + Math.floor(Math.log10(rate + 1)));
    const speed = (boosted ? 0.9 : 0.5) / 1000;
    for (let i = 0; i < count; i++) {
      const progress = (view.time * speed + i / count + tier * 0.137) % 1;
      const cell = path[Math.floor(progress * path.length)];
      if (cell) c.put(cell[0], cell[1], "●", tierStyle(tier));
    }
    c.put(nx, ny, "◉", { ...tierStyle(tier), bold: true });
    const label = `${LABELS[tier]}×${owned}`;
    c.text(Math.round(nx - label.length / 2), Math.round(ny) + 1, label, tierStyle(tier));
  });

  // The core.
  const body = [
    `╭${"─".repeat(coreW - 2)}╮`,
    `│${center("PROCESS", coreW - 2)}│`,
    `│${center(`+${formatShort(clickValue(state))}`, coreW - 2)}│`,
    `╰${"─".repeat(coreW - 2)}╯`,
  ];
  body.forEach((row, i) => c.text(left, top + i, row, coreStyle));
  const spin = ["◐", "◓", "◑", "◒"][Math.floor(view.time / 150) % 4]!;
  c.put(left + 1, top + 1, spin, coreStyle);
  if (boosted) c.text(cx - 6, y0, "OVERCLOCK ×7", S.overclock);
  c.text(left, top + coreH, "[space]".padStart(10), S.muted);

  // The golden packet, while it's on screen.
  const spawn = upcomingGolden(state.golden, state.playMs);
  const progress = (state.playMs - spawn.at) / spawn.visibleMs;
  if (progress >= 0 && progress <= 1) {
    const gx = x0 + Math.round(progress * (w - 1));
    const gy = y0 + 1 + Math.round(spawn.lane * (h - 3));
    c.put(gx, gy, "◆", S.gold);
    c.text(gx + 2, gy, "[g]", S.gold);
  }
}

function drawPanel(
  c: Canvas,
  view: View,
  state: GameState,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  // Tabs.
  let tx = x0 + 1;
  TABS.forEach((tab) => {
    const name = ` ${TAB_NAMES[tab]} `;
    c.text(tx, y0, name, tab === view.tab ? { fg: "#09090b", inverse: true, bold: true } : S.muted);
    tx += name.length + 1;
  });
  c.text(x0 + 1, y0 + 1, "[tab] switch".padEnd(w - 2), S.dim);
  const top = y0 + 3;
  const width = w - 2;
  const x = x0 + 1;
  const rows = h - 3;

  if (view.tab === "build") {
    c.text(x, top - 1, `[x] buy ×${view.buyAmount}`.padStart(width), S.muted);
    const highest = state.owned.reduce((best, n, i) => (n > 0 ? i : best), -1);
    const shown = GENERATORS.slice(0, Math.min(GENERATORS.length, highest + 3));
    shown.forEach((generator, tier) => {
      const y = top + tier * 2;
      if (y + 1 >= top + rows) return;
      const owned = state.owned[tier] ?? 0;
      const cost = generatorCost(state, tier, view.buyAmount);
      const affordable = cost <= state.records;
      const known = owned > 0 || tier <= highest + 1;
      const key = String((tier + 1) % 10);
      c.text(x, y, key, affordable ? S.good : S.dim);
      c.put(x + 2, y, "●", tierStyle(tier, !affordable));
      const name = known ? generator.name : "???";
      c.text(x + 4, y, name, affordable ? S.text : S.muted, width - 18);
      const right = `×${owned}  ${formatShort(cost)}`;
      c.text(x + width - right.length, y, right, affordable ? S.good : S.muted);
      c.text(
        x + 4,
        y + 1,
        known ? generator.blurb : "Keep building to find out.",
        S.dim,
        width - 4,
      );
    });
    return;
  }

  if (view.tab === "upgrades") {
    const list = listedUpgrades(state);
    if (list.length === 0) {
      c.text(x, top, "Nothing new yet. Upgrades unlock", S.muted);
      c.text(x, top + 1, "as you build and click.", S.muted);
      return;
    }
    list.forEach((upgrade, i) => {
      const y = top + i * 2;
      if (y + 1 >= top + rows) return;
      const affordable = upgrade.cost <= state.records;
      const ending = upgrade.id === ENDING_UPGRADE;
      c.text(x, y, UPGRADE_KEYS[i]!, affordable ? S.good : S.dim);
      c.text(x + 2, y, upgrade.name, ending ? S.gold : affordable ? S.text : S.muted, width - 12);
      const cost = formatShort(upgrade.cost);
      c.text(x + width - cost.length, y, cost, affordable ? S.good : S.muted);
      c.text(x + 2, y + 1, upgrade.blurb, S.dim, width - 2);
    });
    return;
  }

  if (view.tab === "migrate") {
    const gain = migrationGain(state);
    const lines: [string, Style][] = [
      ["Platform Migration", { ...S.text, bold: true }],
      ["", S.text],
      ["Throw out the stack and rebuild. You", S.muted],
      ["lose records, generators and upgrades,", S.muted],
      [`and get Architecture Points: +${Math.round(AP_BONUS * 100)} % each,`, S.muted],
      ["forever. Achievements stay.", S.muted],
      ["", S.text],
      [`You have          ${state.ap} AP`, S.text],
      [`Migrating gives   +${gain} AP`, S.violet],
      [`This run          ${formatShort(state.runRecords)}`, S.text],
      [`Next point at     ${formatShort(nextPointAt(state))}`, S.muted],
      ["", S.text],
      gain < 1
        ? ["Not enough records yet.", S.muted]
        : view.confirmMigrate
          ? [`Press [m] again to migrate for ${gain} AP.`, S.warn]
          : ["[m] start migration", S.good],
    ];
    lines.forEach(([text, style], i) => c.text(x, top - 1 + i, text, style, width));
    return;
  }

  // Stats.
  const stats: [string, string][] = [
    ["Records ever", formatShort(state.lifetimeRecords)],
    ["Base production", `${formatShort(baseRate(state))}/s`],
    ["Play time", formatDuration(state.playMs)],
    ["This run", formatDuration(state.runMs)],
    ["Clicks", state.clicks.toLocaleString("en-US")],
    ["Golden packets", String(state.goldenCaught)],
    ["Migrations", String(state.migrations)],
    ["Achievements", `${state.achievements.length}/${ACHIEVEMENTS.length}`],
  ];
  stats.forEach(([label, value], i) => {
    c.text(x, top - 1 + i, label, S.muted);
    c.text(x + width - value.length, top - 1 + i, value, S.text);
  });
  let y = top - 1 + stats.length + 1;
  c.text(
    x,
    y++,
    view.saving
      ? "Saving…"
      : view.lastSavedAt
        ? `Saved at ${new Date(view.lastSavedAt).toLocaleTimeString()}`
        : "Not saved yet",
    S.muted,
  );
  c.text(x, y++, "[s] save now", S.good);
  y++;
  c.text(x, y++, "Open this game in a browser:", S.text);
  if (view.pairing && view.pairing.until > Date.now()) {
    const left = Math.ceil((view.pairing.until - Date.now()) / 1000);
    c.text(x, y++, `${view.pairing.code.slice(0, 3)} ${view.pairing.code.slice(3)}`, {
      ...S.good,
      bold: true,
    });
    c.text(
      x,
      y++,
      `Stats → "Have a code?" · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
      S.muted,
      width,
    );
  } else {
    c.text(x, y++, "[c] show a link code", S.good);
  }
  // The latest achievements, if there's room.
  y++;
  const recent = state.achievements.slice(-Math.max(0, top + rows - y));
  for (const id of recent) {
    const achievement = ACHIEVEMENTS.find((a) => a.id === id);
    if (achievement && y < y0 + h) c.text(x, y++, `★ ${achievement.name}`, S.violet, width);
  }
}

const KEY_HELP =
  "[space] process  [1-0] build  [x] amount  [tab] panel  [g] golden  [s] save  [q] quit";

export function renderFrame(view: View): Canvas {
  const c = new Canvas(view.cols, view.rows);
  if (view.cols < MIN_COLS || view.rows < MIN_ROWS) {
    const message = `Make the terminal at least ${MIN_COLS}×${MIN_ROWS} (now ${view.cols}×${view.rows}).`;
    c.text(0, 0, message, S.warn);
    c.text(0, 1, "[q] quit", S.muted);
    return c;
  }
  const { state } = view;

  // Title bar.
  c.text(1, 0, "PIPELINE TYCOON", S.title);
  if (state) {
    const records = `${formatShort(state.records)} records`;
    const rate = `+${formatShort(currentRate(state))}/s`;
    c.text(18, 0, records, { ...S.text, bold: true });
    c.text(18 + records.length + 2, 0, rate, S.muted);
    if (state.ap > 0) c.text(18 + records.length + rate.length + 4, 0, `${state.ap} AP`, S.violet);
  }
  c.text(view.cols - view.serverLabel.length - 1, 0, view.serverLabel, S.dim);

  const panelW = Math.min(46, Math.max(38, Math.floor(view.cols * 0.42)));
  const sceneW = view.cols - panelW - 1;
  const bodyTop = 1;
  const bodyH = view.rows - 3;
  for (let y = bodyTop; y < bodyTop + bodyH; y++) c.put(sceneW, y, "│", S.dim);

  if (view.status.kind === "loading" || !state) {
    c.text(2, bodyTop + 1, "Connecting…", S.muted);
  } else {
    drawScene(c, view, state, 0, bodyTop, sceneW, bodyH);
    drawPanel(c, view, state, sceneW + 1, bodyTop, panelW, bodyH);
  }

  // Toast and key help.
  const status =
    view.status.kind === "stopped" ? stoppedMessage(view.status.failure.kind) : view.toast;
  if (status)
    c.text(
      1,
      view.rows - 2,
      status,
      view.status.kind === "stopped" ? S.warn : S.good,
      view.cols - 2,
    );
  c.text(1, view.rows - 1, KEY_HELP, S.muted, view.cols - 2);
  return c;
}

export function stoppedMessage(kind: string): string {
  switch (kind) {
    case "session_replaced":
      return "Paused: you're playing on another device. [r] continue here  [q] quit";
    case "update_required":
      return "This CLI is out of date. Quit and run: npx @rymart/pipeline-tycoon@latest";
    case "out_of_sync":
      return "Out of sync with your save. [r] reload  [q] quit";
    case "rate_limited":
      return "Too many new players from your network. Try again in a minute. [r] retry";
    default:
      return "Can't reach the server. [r] retry  [q] quit";
  }
}

export const ENDING_LINES = [
  "> integrate --target=earth",
  "[ok] 8,100,000,000 humans … synced",
  "[ok] 17,000,000,000 devices … synced",
  "[ok] every toaster on the planet … synced",
  "[ok] all data on Earth has been integrated.",
  "",
  "INCOMING CONNECTION REQUEST — ORIGIN: UNKNOWN — PROTOCOL: UNRECOGNIZED",
];

/** The soft ending, full screen: `shown` lines of the terminal so far. */
export function renderEnding(cols: number, rows: number, shown: number): Canvas {
  const c = new Canvas(cols, rows);
  const x = Math.max(2, Math.floor((cols - 72) / 2));
  let y = Math.max(1, Math.floor(rows / 2) - 7);
  c.text(x, y++, "INTEGRATION COMPLETE", S.title);
  c.text(x, y++, "You integrated Earth. There is nothing left to connect.", S.text);
  y++;
  ENDING_LINES.slice(0, shown).forEach((text, i) => {
    const last = i === ENDING_LINES.length - 1;
    c.text(x, y++, text, last ? { fg: "#fda4af", bold: true } : S.good, cols - x - 1);
  });
  if (shown >= ENDING_LINES.length) {
    y++;
    c.text(x, y++, "[ACCEPT] (unavailable)", S.dim);
    c.text(x, y + 1, "Press any key to keep playing.", S.muted);
  }
  return c;
}
