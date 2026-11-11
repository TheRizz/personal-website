import * as Phaser from "phaser";
import {
  GENERATORS,
  clickValue,
  formatNumber,
  overclocked,
  tierRate,
  upcomingGolden,
  type GameEvent,
  type GameState,
  type TycoonController,
} from "@site/tycoon-core";

import { TIER_COLOURS } from "./colours";
import { factoryLayout, labelPlacement, nodeRadius } from "./factory-layout";
import {
  GoldenWatch,
  goldenPoint,
  goldenTrail,
  ringSweep,
  secondsLeft,
  trailPulse,
} from "./golden-visual";
import type { TycoonSettings } from "./settings";
import {
  BURST_CAP,
  FLOAT_CAP,
  circlePoints,
  PACKET_CAP,
  packetsPerSecond,
  pickSlot,
  spawnPackets,
  tierCap,
} from "./scene-budget";
import { playGoldenChime } from "./sound";

// The live "factory": a dark neon schematic drawn in code (no image assets, so the CSP needs no
// data:/blob: textures). Tiers appear as nodes around the core as you buy them, links glow, and
// packets flow into the core at a rate that grows with each tier's production. Loaded only in
// the browser (games.pipeline-tycoon.tsx imports it dynamically): Phaser touches `window`.

const CORE = 0x22d3ee;
const OVERCLOCK = 0xf472b6;
const GOLD = 0xfbbf24;
const BG = 0x07090c;
const GRID = 0x0f1720;
/** Fingers the core answers at once (two thumbs, with room for a stray one). */
const TOUCH_POINTERS = 4;
/** One packet's look (a soft glow round a bright dot), drawn once and tinted per tier. */
const PACKET_TEXTURE = "tycoon-packet";
const PACKET_SIZE = 12;

// fillPoints and strokePoints only read x and y, though their types ask for Vector2s.
const corners = (x: number, y: number, radius: number) =>
  circlePoints(x, y, radius) as unknown as Phaser.Math.Vector2[];

/** Circles with as many corners as their size needs (Phaser's own always use 100). */
function fillCircle(g: Phaser.GameObjects.Graphics, x: number, y: number, radius: number) {
  if (radius > 0) g.fillPoints(corners(x, y, radius), true);
}

function strokeCircle(g: Phaser.GameObjects.Graphics, x: number, y: number, radius: number) {
  if (radius > 0) g.strokePoints(corners(x, y, radius), true, true);
}

interface Packet {
  tier: number;
  /** 0 at the node, 1 at the core. */
  progress: number;
  speed: number;
}

interface Float {
  text: Phaser.GameObjects.Text;
  /** When it appeared (scene time), or null while it's free. */
  born: number | null;
}

interface Burst {
  x: number;
  y: number;
  age: number;
  colour: number;
}

/** Told when a golden packet arrives (with a line for screen readers) and when it goes. */
export type GoldenNotice = (text: string | null) => void;

/** Short labels for the nodes. */
const LABELS = ["CSV", "CRON", "SFTP", "REST", "MQ", "ETL", "LAKE", "MESH", "SAT", "GRID"];

class FactoryScene extends Phaser.Scene {
  private controller!: TycoonController;
  private settings!: () => TycoonSettings;
  private onGolden: GoldenNotice = () => {};
  private goldenWatch = new GoldenWatch();
  /** The grid, redrawn only when the scene changes size. */
  private grid!: Phaser.GameObjects.Graphics;
  private gridSize = "";
  /** Links and nodes, under the packets. */
  private graphics!: Phaser.GameObjects.Graphics;
  /** The core, rings and golden packet, over the packets. */
  private front!: Phaser.GameObjects.Graphics;
  /** Packet sprites, PACKET_CAP of them made once; the first `packets.length` are shown. */
  private sprites: Phaser.GameObjects.Image[] = [];
  private shown = 0;
  private floats: Float[] = [];
  private reportAt = 0;
  private labels: Phaser.GameObjects.Text[] = [];
  private coreLabel!: Phaser.GameObjects.Text;
  private packets: Packet[] = [];
  private bursts: Burst[] = [];
  private spawnDebt = GENERATORS.map(() => 0);
  private corePulse = 0;
  private coreFont = 12;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super("factory");
  }

  init(data: {
    controller: TycoonController;
    settings: () => TycoonSettings;
    onGolden?: GoldenNotice;
  }) {
    this.controller = data.controller;
    this.settings = data.settings;
    if (data.onGolden) this.onGolden = data.onGolden;
  }

  private format(value: number) {
    return formatNumber(value, this.settings().notation);
  }

  create() {
    this.grid = this.add.graphics();
    this.graphics = this.add.graphics();
    if (!this.textures.exists(PACKET_TEXTURE)) {
      const texture = this.textures.createCanvas(PACKET_TEXTURE, PACKET_SIZE, PACKET_SIZE)!;
      const context = texture.getContext();
      const middle = PACKET_SIZE / 2;
      context.fillStyle = "rgba(255, 255, 255, 0.25)";
      context.beginPath();
      context.arc(middle, middle, 5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.arc(middle, middle, 2, 0, Math.PI * 2);
      context.fill();
      texture.refresh();
    }
    this.sprites = Array.from({ length: PACKET_CAP }, () =>
      this.add.image(0, 0, PACKET_TEXTURE).setVisible(false),
    );
    this.front = this.add.graphics();
    // Text renders at the screen's pixel density, so it stays crisp on phones.
    const mono = {
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      resolution: Math.min(3, window.devicePixelRatio || 1),
    };
    this.labels = GENERATORS.map((_, tier) =>
      this.add
        .text(0, 0, "", { ...mono, fontSize: "11px", color: "#cbd5e1", align: "center" })
        .setOrigin(0.5, 0)
        .setAlpha(0)
        .setData("tier", tier),
    );
    this.coreLabel = this.add
      .text(0, 0, "", { ...mono, fontSize: "12px", color: "#a5f3fc", align: "center" })
      .setOrigin(0.5, 0);
    this.floats = Array.from({ length: FLOAT_CAP }, () => ({
      text: this.add
        .text(0, 0, "", { ...mono, fontSize: "14px" })
        .setOrigin(0.5)
        .setVisible(false),
      born: null,
    }));

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handlePointer(pointer));
    this.unsubscribe = this.controller.onEvent((event) => this.handleEvent(event));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubscribe?.());
  }

  /** Where everything sits for the current size. */
  private layout() {
    return factoryLayout(this.scale.width, this.scale.height);
  }

  private goldenPosition(state: GameState, width: number, top: number, area: number) {
    const spawn = upcomingGolden(state.golden, state.playMs);
    const progress = (state.playMs - spawn.at) / spawn.visibleMs;
    if (progress < 0 || progress > 1) return null;
    return {
      index: spawn.index,
      ...goldenPoint(progress, spawn.lane, width, top, area),
      progress,
      lane: spawn.lane,
      visibleMs: spawn.visibleMs,
    };
  }

  private handlePointer(pointer: Phaser.Input.Pointer) {
    const state = this.controller.local;
    if (!state) return;
    const { width, top, area, cx, cy, coreRadius } = this.layout();
    const golden = this.goldenPosition(state, width, top, area);
    if (golden && Phaser.Math.Distance.Between(pointer.x, pointer.y, golden.x, golden.y) < 32) {
      this.controller.catchGolden(golden.index);
      return;
    }
    if (Phaser.Math.Distance.Between(pointer.x, pointer.y, cx, cy) < coreRadius * 1.6) {
      this.controller.click();
    }
  }

  private handleEvent(event: GameEvent) {
    const { cx, cy, coreRadius, nodes } = this.layout();
    switch (event.type) {
      case "click": {
        this.corePulse = 1;
        this.floatText(
          cx + Phaser.Math.Between(-20, 20),
          cy - coreRadius - 6,
          `+${this.format(event.earned)}`,
          "#a5f3fc",
        );
        break;
      }
      case "buy": {
        if (this.settings().reduceMotion) break;
        const node = nodes[event.tier];
        if (node) this.addBurst({ ...node, age: 0, colour: TIER_COLOURS[event.tier] ?? CORE });
        break;
      }
      case "golden": {
        if (!this.settings().reduceMotion) this.addBurst({ x: cx, y: cy, age: 0, colour: GOLD });
        this.floatText(
          cx,
          cy - coreRadius - 24,
          event.kind === "burst" ? `+${this.format(event.earned ?? 0)}` : "OVERCLOCK ×7",
          "#fde68a",
        );
        break;
      }
      case "migrate":
        this.packets = [];
        if (!this.settings().reduceMotion) {
          this.addBurst({ x: cx, y: cy, age: 0, colour: 0xffffff });
        }
        break;
      default:
        break;
    }
  }

  /** A ring, dropping the oldest when BURST_CAP are already showing. */
  private addBurst(burst: Burst) {
    if (this.bursts.length >= BURST_CAP) this.bursts.shift();
    this.bursts.push(burst);
  }

  /** A number that floats up and fades, reusing the oldest when FLOAT_CAP are showing. */
  private floatText(x: number, y: number, text: string, color: string) {
    const now = this.time.now;
    const slot =
      this.floats[pickSlot(this.floats.map((f) => (f.born === null ? null : now - f.born)))];
    if (!slot) return;
    const label = slot.text;
    this.tweens.killTweensOf(label);
    slot.born = now;
    label.setText(text).setColor(color).setPosition(x, y).setAlpha(1).setVisible(true);
    // With reduced motion the number fades where it appeared instead of rising.
    const still = this.settings().reduceMotion;
    this.tweens.add({
      targets: label,
      y: still ? y : y - 40,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeOut",
      onComplete: () => {
        label.setVisible(false);
        slot.born = null;
      },
    });
  }

  /** Shows the first `count` packet sprites and hides the rest that were showing. */
  private showSprites(count: number) {
    for (let i = count; i < this.shown; i++) this.sprites[i]!.setVisible(false);
    this.shown = count;
  }

  /** Drawn counts on the canvas, a few times a second, for the browser tests. */
  private report() {
    if (this.time.now < this.reportAt) return;
    this.reportAt = this.time.now + 500;
    const canvas = this.game.canvas;
    canvas.dataset.packets = String(this.packets.length);
    canvas.dataset.floats = String(this.floats.filter((f) => f.born !== null).length);
    canvas.dataset.bursts = String(this.bursts.length);
  }

  update(_time: number, delta: number) {
    this.controller.tick();
    const state = this.controller.local;
    const g = this.graphics;
    const front = this.front;
    g.clear();
    front.clear();
    const layout = this.layout();
    const { width, height, top, area, cx, cy, coreRadius, nodes } = layout;
    const dt = Math.min(delta, 100) / 1000;
    const still = this.settings().reduceMotion;

    // Background grid, only when the size changed.
    const size = `${width}x${height}`;
    if (size !== this.gridSize) {
      this.gridSize = size;
      const grid = this.grid;
      grid.clear();
      grid.fillStyle(BG, 1);
      grid.fillRect(0, 0, width, height);
      grid.lineStyle(1, GRID, 1);
      for (let x = (cx % 32) - 32; x < width; x += 32) grid.lineBetween(x, 0, x, height);
      for (let y = (cy % 32) - 32; y < height; y += 32) grid.lineBetween(0, y, width, y);
    }
    if (!state) {
      this.showSprites(0);
      return;
    }

    const boosted = overclocked(state);
    const coreColour = boosted ? OVERCLOCK : CORE;

    // Links and nodes for every tier owned. Each tier may hold its share of the packet cap.
    const live = GENERATORS.map(() => 0);
    for (const packet of this.packets) live[packet.tier] = (live[packet.tier] ?? 0) + 1;
    const share = tierCap(state.owned.filter((count) => count > 0).length);
    nodes.forEach((node, tier) => {
      const owned = state.owned[tier] ?? 0;
      const label = this.labels[tier]!;
      const colour = TIER_COLOURS[tier] ?? CORE;
      if (owned === 0) {
        label.setAlpha(0);
        this.spawnDebt[tier] = 0;
        return;
      }
      g.lineStyle(6, colour, 0.08);
      g.lineBetween(node.x, node.y, cx, cy);
      g.lineStyle(1.5, colour, 0.45);
      g.lineBetween(node.x, node.y, cx, cy);
      const radius = nodeRadius(layout, owned);
      g.fillStyle(colour, 0.12);
      fillCircle(g, node.x, node.y, radius * 1.33);
      g.fillStyle(BG, 1);
      fillCircle(g, node.x, node.y, radius);
      g.lineStyle(2, colour, 0.95);
      strokeCircle(g, node.x, node.y, radius);
      const place = labelPlacement(layout, tier, radius);
      label.setText(`${LABELS[tier]}\n×${owned}`);
      label.setOrigin(place.origin.x, place.origin.y);
      label.setPosition(place.x, place.y);
      label.setAlpha(Math.min(1, label.alpha + dt * 2));

      const perSecond = packetsPerSecond(tierRate(state, tier), boosted);
      const step = spawnPackets(this.spawnDebt[tier] ?? 0, perSecond, dt, live[tier] ?? 0, share);
      this.spawnDebt[tier] = step.debt;
      for (let i = 0; i < step.spawn; i++) {
        this.packets.push({ tier, progress: 0, speed: 0.45 + Math.random() * 0.35 });
      }
    });

    // Packets travelling into the core: sprites from one texture, drawn in one batch.
    this.packets = this.packets.filter((packet) => {
      packet.progress += packet.speed * dt * (boosted ? 1.8 : 1);
      return packet.progress < 1;
    });
    this.packets.forEach((packet, index) => {
      const node = nodes[packet.tier]!;
      this.sprites[index]
        ?.setPosition(
          node.x + (cx - node.x) * packet.progress,
          node.y + (cy - node.y) * packet.progress,
        )
        .setTint(TIER_COLOURS[packet.tier] ?? CORE)
        .setVisible(true);
    });
    this.showSprites(Math.min(this.packets.length, this.sprites.length));

    // The core: the big click target.
    this.corePulse = still ? 0 : Math.max(0, this.corePulse - dt * 4);
    const pulse = still
      ? coreRadius
      : coreRadius * (1 + this.corePulse * 0.12 + Math.sin(this.time.now / 400) * 0.02);
    front.fillStyle(coreColour, 0.06);
    fillCircle(front, cx, cy, pulse * 1.9);
    front.fillStyle(coreColour, 0.12);
    fillCircle(front, cx, cy, pulse * 1.35);
    front.fillStyle(BG, 1);
    fillCircle(front, cx, cy, pulse);
    front.lineStyle(3, coreColour, 1);
    strokeCircle(front, cx, cy, pulse);
    front.lineStyle(1, coreColour, 0.5);
    strokeCircle(front, cx, cy, pulse * 0.62);
    // A little rotating "processing" arc.
    const spin = still ? -Math.PI / 2 : this.time.now / 600;
    front.lineStyle(2, coreColour, 0.9);
    front.beginPath();
    front.arc(cx, cy, pulse * 0.62, spin, spin + Math.PI * 0.6);
    front.strokePath();
    this.coreLabel.setText(`PROCESS\n+${this.format(clickValue(state))}`);
    const coreFont = coreRadius < 52 ? 10 : 12;
    if (coreFont !== this.coreFont) this.coreLabel.setFontSize((this.coreFont = coreFont));
    this.coreLabel.setPosition(cx, cy - (coreRadius < 52 ? 12 : 14));
    const coreText = boosted ? "#fbcfe8" : "#a5f3fc";
    if (this.coreLabel.style.color !== coreText) this.coreLabel.setColor(coreText);

    // Purchase and catch bursts.
    this.bursts = this.bursts.filter((burst) => {
      burst.age += dt;
      if (burst.age > 0.6) return false;
      front.lineStyle(2, burst.colour, 1 - burst.age / 0.6);
      strokeCircle(front, burst.x, burst.y, 12 + burst.age * 90);
      return true;
    });
    this.report();

    // The golden packet, while it's on screen: a pulsing trail behind it, a ring that empties as
    // its time runs out, and a soft chime and a spoken line when it arrives.
    const golden = this.goldenPosition(state, width, top, area);
    const change = this.goldenWatch.update(golden?.index ?? null);
    if (change === "arrived" && golden) {
      if (this.settings().sound) playGoldenChime();
      const seconds = secondsLeft(golden.progress, golden.visibleMs);
      this.onGolden(`Golden packet in the factory: tap it within ${seconds} seconds.`);
    } else if (change === "left") {
      this.onGolden(null);
    }
    if (golden) {
      const pulse = trailPulse(this.time.now, still);
      for (const dot of goldenTrail(golden.progress)) {
        const at = goldenPoint(dot.progress, golden.lane, width, top, area);
        front.fillStyle(GOLD, dot.alpha * pulse);
        fillCircle(front, at.x, at.y, 3 + dot.alpha * 6);
      }
      const size = still ? 12 : 11 + Math.sin(this.time.now / 120) * 2;
      front.fillStyle(GOLD, 0.18);
      fillCircle(front, golden.x, golden.y, size * 2.2);
      // Time left: the faint full circle is the whole 12 s, the bright arc what remains.
      const ring = size * 2.2 + 4;
      front.lineStyle(2, GOLD, 0.2);
      strokeCircle(front, golden.x, golden.y, ring);
      front.lineStyle(2.5, GOLD, 0.95);
      front.beginPath();
      front.arc(golden.x, golden.y, ring, -Math.PI / 2, -Math.PI / 2 + ringSweep(golden.progress));
      front.strokePath();
      front.fillStyle(GOLD, 1);
      front.fillTriangle(
        golden.x,
        golden.y - size,
        golden.x + size,
        golden.y,
        golden.x - size,
        golden.y,
      );
      front.fillTriangle(
        golden.x,
        golden.y + size,
        golden.x + size,
        golden.y,
        golden.x - size,
        golden.y,
      );
    }
  }
}

/** Mounts the scene in `parent`; returns a function that tears it down. */
export function mountFactory(
  parent: HTMLElement,
  controller: TycoonController,
  settings: () => TycoonSettings,
  onGolden?: GoldenNotice,
): () => void {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: BG,
    banner: false,
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    // Only touches that start on the canvas, and one pointer per finger. With window events on,
    // a touch anywhere on the page (the Migrate button, the shop) took the scene's only touch
    // pointer, and if its end never arrived (iOS loses it when the touched element changes
    // under the finger) the core ignored every tap until a reload.
    input: { keyboard: false, windowEvents: false, activePointers: TOUCH_POINTERS },
    render: { antialias: true },
    scene: [],
  });
  game.scene.add("factory", FactoryScene, true, { controller, settings, onGolden });
  // Belt and braces: a new touch frees any pointer still held by a finger that has gone.
  const releaseLost = (event: TouchEvent) => {
    const live = new Set(Array.from(event.touches, (touch) => touch.identifier));
    for (const pointer of game.input?.pointers.slice(1) ?? []) {
      if (pointer.active && !live.has(pointer.identifier)) {
        pointer.active = false;
        pointer.isDown = false;
      }
    }
  };
  parent.addEventListener("touchstart", releaseLost, { capture: true, passive: true });
  return () => {
    parent.removeEventListener("touchstart", releaseLost, { capture: true });
    game.destroy(true);
  };
}
