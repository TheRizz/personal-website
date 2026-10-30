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
import type { TycoonSettings } from "./settings";

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

interface Packet {
  tier: number;
  /** 0 at the node, 1 at the core. */
  progress: number;
  speed: number;
}

interface Burst {
  x: number;
  y: number;
  age: number;
  colour: number;
}

/** Short labels for the nodes. */
const LABELS = ["CSV", "CRON", "SFTP", "REST", "MQ", "ETL", "LAKE", "MESH", "SAT", "GRID"];

class FactoryScene extends Phaser.Scene {
  private controller!: TycoonController;
  private settings!: () => TycoonSettings;
  private graphics!: Phaser.GameObjects.Graphics;
  private labels: Phaser.GameObjects.Text[] = [];
  private coreLabel!: Phaser.GameObjects.Text;
  private bannerLabel!: Phaser.GameObjects.Text;
  private packets: Packet[] = [];
  private bursts: Burst[] = [];
  private spawnDebt = GENERATORS.map(() => 0);
  private corePulse = 0;
  private coreFont = 12;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super("factory");
  }

  init(data: { controller: TycoonController; settings: () => TycoonSettings }) {
    this.controller = data.controller;
    this.settings = data.settings;
  }

  private format(value: number) {
    return formatNumber(value, this.settings().notation);
  }

  create() {
    this.graphics = this.add.graphics();
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
    this.bannerLabel = this.add
      .text(0, 0, "", { ...mono, fontSize: "12px", color: "#fbcfe8" })
      .setOrigin(0.5, 0);

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handlePointer(pointer));
    this.unsubscribe = this.controller.onEvent((event) => this.handleEvent(event));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubscribe?.());
  }

  /** Where everything sits for the current size. */
  private layout() {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;
    const rx = Math.max(60, width / 2 - 48);
    const ry = Math.max(50, height / 2 - 40);
    const coreRadius = Math.max(40, Math.min(width, height) * 0.12);
    const nodes = GENERATORS.map((_, tier) => {
      // Spread the ten tiers around the core, starting at the top-left and going clockwise.
      const angle = -Math.PI * 0.85 + (tier / GENERATORS.length) * Math.PI * 2;
      return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
    });
    return { width, height, cx, cy, coreRadius, nodes };
  }

  private goldenPosition(state: GameState, width: number, height: number) {
    const spawn = upcomingGolden(state.golden, state.playMs);
    const progress = (state.playMs - spawn.at) / spawn.visibleMs;
    if (progress < 0 || progress > 1) return null;
    const y = height * (0.18 + spawn.lane * 0.64) + Math.sin(progress * Math.PI * 4) * 10;
    return { index: spawn.index, x: -20 + progress * (width + 40), y, progress };
  }

  private handlePointer(pointer: Phaser.Input.Pointer) {
    const state = this.controller.local;
    if (!state) return;
    const { width, height, cx, cy, coreRadius } = this.layout();
    const golden = this.goldenPosition(state, width, height);
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
        if (node) this.bursts.push({ ...node, age: 0, colour: TIER_COLOURS[event.tier] ?? CORE });
        break;
      }
      case "golden": {
        if (!this.settings().reduceMotion) this.bursts.push({ x: cx, y: cy, age: 0, colour: GOLD });
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
          this.bursts.push({ x: cx, y: cy, age: 0, colour: 0xffffff });
        }
        break;
      default:
        break;
    }
  }

  private floatText(x: number, y: number, text: string, color: string) {
    const label = this.add
      .text(x, y, text, {
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: "14px",
        resolution: Math.min(3, window.devicePixelRatio || 1),
        color,
      })
      .setOrigin(0.5);
    // With reduced motion the number fades where it appeared instead of rising.
    const still = this.settings().reduceMotion;
    this.tweens.add({
      targets: label,
      y: still ? y : y - 40,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  update(_time: number, delta: number) {
    this.controller.tick();
    const state = this.controller.local;
    const g = this.graphics;
    g.clear();
    const { width, height, cx, cy, coreRadius, nodes } = this.layout();
    const dt = Math.min(delta, 100) / 1000;
    const still = this.settings().reduceMotion;

    // Background grid.
    g.fillStyle(BG, 1);
    g.fillRect(0, 0, width, height);
    g.lineStyle(1, GRID, 1);
    for (let x = (cx % 32) - 32; x < width; x += 32) g.lineBetween(x, 0, x, height);
    for (let y = (cy % 32) - 32; y < height; y += 32) g.lineBetween(0, y, width, y);
    if (!state) return;

    const boosted = overclocked(state);
    const coreColour = boosted ? OVERCLOCK : CORE;

    // Links and nodes for every tier owned.
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
      const radius = 9 + Math.min(12, Math.log2(owned + 1) * 1.6);
      g.fillStyle(colour, 0.12);
      g.fillCircle(node.x, node.y, radius + 7);
      g.fillStyle(BG, 1);
      g.fillCircle(node.x, node.y, radius);
      g.lineStyle(2, colour, 0.95);
      g.strokeCircle(node.x, node.y, radius);
      label.setText(`${LABELS[tier]}\n×${owned}`);
      label.setPosition(node.x, node.y + radius + 4);
      label.setAlpha(Math.min(1, label.alpha + dt * 2));

      // Packets per second grow with the log of production, so the screen stays readable.
      const rate = tierRate(state, tier) * (boosted ? 7 : 1);
      const perSecond = Math.min(14, 0.6 + Math.log10(rate + 1) * 1.4);
      this.spawnDebt[tier] = (this.spawnDebt[tier] ?? 0) + perSecond * dt;
      while ((this.spawnDebt[tier] ?? 0) >= 1 && this.packets.length < 400) {
        this.spawnDebt[tier]! -= 1;
        this.packets.push({ tier, progress: 0, speed: 0.45 + Math.random() * 0.35 });
      }
    });

    // Packets travelling into the core.
    this.packets = this.packets.filter((packet) => {
      packet.progress += packet.speed * dt * (boosted ? 1.8 : 1);
      if (packet.progress >= 1) return false;
      const node = nodes[packet.tier]!;
      const x = node.x + (cx - node.x) * packet.progress;
      const y = node.y + (cy - node.y) * packet.progress;
      const colour = TIER_COLOURS[packet.tier] ?? CORE;
      g.fillStyle(colour, 0.25);
      g.fillCircle(x, y, 5);
      g.fillStyle(colour, 1);
      g.fillCircle(x, y, 2);
      return true;
    });

    // The core: the big click target.
    this.corePulse = still ? 0 : Math.max(0, this.corePulse - dt * 4);
    const pulse = still
      ? coreRadius
      : coreRadius * (1 + this.corePulse * 0.12 + Math.sin(this.time.now / 400) * 0.02);
    g.fillStyle(coreColour, 0.06);
    g.fillCircle(cx, cy, pulse * 1.9);
    g.fillStyle(coreColour, 0.12);
    g.fillCircle(cx, cy, pulse * 1.35);
    g.fillStyle(BG, 1);
    g.fillCircle(cx, cy, pulse);
    g.lineStyle(3, coreColour, 1);
    g.strokeCircle(cx, cy, pulse);
    g.lineStyle(1, coreColour, 0.5);
    g.strokeCircle(cx, cy, pulse * 0.62);
    // A little rotating "processing" arc.
    const spin = still ? -Math.PI / 2 : this.time.now / 600;
    g.lineStyle(2, coreColour, 0.9);
    g.beginPath();
    g.arc(cx, cy, pulse * 0.62, spin, spin + Math.PI * 0.6);
    g.strokePath();
    this.coreLabel.setText(`PROCESS\n+${this.format(clickValue(state))}`);
    const coreFont = coreRadius < 52 ? 10 : 12;
    if (coreFont !== this.coreFont) this.coreLabel.setFontSize((this.coreFont = coreFont));
    this.coreLabel.setPosition(cx, cy - (coreRadius < 52 ? 12 : 14));
    const coreText = boosted ? "#fbcfe8" : "#a5f3fc";
    if (this.coreLabel.style.color !== coreText) this.coreLabel.setColor(coreText);
    this.bannerLabel.setText(boosted ? "OVERCLOCK ×7" : "");
    this.bannerLabel.setPosition(cx, 10);

    // Purchase and catch bursts.
    this.bursts = this.bursts.filter((burst) => {
      burst.age += dt;
      if (burst.age > 0.6) return false;
      g.lineStyle(2, burst.colour, 1 - burst.age / 0.6);
      g.strokeCircle(burst.x, burst.y, 12 + burst.age * 90);
      return true;
    });

    // The golden packet, while it's on screen.
    const golden = this.goldenPosition(state, width, height);
    if (golden) {
      const size = still ? 12 : 11 + Math.sin(this.time.now / 120) * 2;
      g.fillStyle(GOLD, 0.18);
      g.fillCircle(golden.x, golden.y, size * 2.2);
      g.fillStyle(GOLD, 1);
      g.fillTriangle(
        golden.x,
        golden.y - size,
        golden.x + size,
        golden.y,
        golden.x - size,
        golden.y,
      );
      g.fillTriangle(
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
  game.scene.add("factory", FactoryScene, true, { controller, settings });
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
