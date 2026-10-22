import {
  ACHIEVEMENTS,
  TycoonController,
  formatDuration,
  formatShort,
  upcomingGolden,
  type GameEvent,
  type TycoonClient,
} from "@site/tycoon-core";
import {
  ENDING_LINES,
  TABS,
  UPGRADE_KEYS,
  listedUpgrades,
  renderEnding,
  renderFrame,
  type Tab,
  type View,
} from "./render";
import type { ColorMode } from "./screen";

// The interactive game: alternate screen, raw keys, ~15 frames a second. Everything the game does
// goes through the shared controller, so progress is the same as on the web.

const FRAME_MS = 66;
const TOAST_MS = 4_000;
const BUY_AMOUNTS = [1, 10, 100] as const;

const ESC = "\x1b";
const enterScreen = `${ESC}[?1049h${ESC}[?25l${ESC}[2J`;
const leaveScreen = `${ESC}[0m${ESC}[?25h${ESC}[?1049l`;

export interface PlayOptions {
  client: TycoonClient;
  colorMode: ColorMode;
  serverLabel: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/** Splits a chunk of raw input into keys (escape sequences stay whole). */
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === ESC && data[i + 1] === "[") {
      let j = i + 2;
      while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
      keys.push(data.slice(i, j + 1));
      i = j;
    } else keys.push(data[i]!);
  }
  return keys;
}

export async function play(options: PlayOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const controller = new TycoonController(options.client);

  let tab: Tab = "build";
  let buyAmount: (typeof BUY_AMOUNTS)[number] = 1;
  let toast: { text: string; until: number } | null = null;
  let confirmMigrate = false;
  let pairing: { code: string; until: number } | null = null;
  let ending: { shown: number; timer: NodeJS.Timeout | null } | null = null;
  let quitting = false;

  const say = (text: string, ms = TOAST_MS) => {
    toast = { text, until: Date.now() + ms };
  };

  const draw = () => {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const canvas = ending
      ? renderEnding(cols, rows, ending.shown)
      : renderFrame({
          cols,
          rows,
          time: performance.now(),
          state: controller.local,
          status: controller.status,
          tab,
          buyAmount,
          toast: toast && toast.until > Date.now() ? toast.text : null,
          saving: controller.saving,
          lastSavedAt: controller.lastSavedAt,
          confirmMigrate,
          pairing,
          serverLabel: options.serverLabel,
        } satisfies View);
    stdout.write(`${ESC}[H${canvas.toAnsi(options.colorMode)}`);
  };

  const stopEnding = () => {
    if (ending?.timer) clearTimeout(ending.timer);
  };

  const startEnding = () => {
    ending = { shown: 0, timer: null };
    const next = () => {
      if (!ending) return;
      ending.shown += 1;
      if (ending.shown < ENDING_LINES.length) {
        ending.timer = setTimeout(next, ending.shown === 5 ? 2_200 : 700);
      }
    };
    ending.timer = setTimeout(next, 2_000);
  };

  controller.onEvent((event: GameEvent) => {
    switch (event.type) {
      case "achievement": {
        const names = event.ids.map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.name ?? id);
        say(`★ Achievement: ${names.join(", ")} (+1 %)`);
        break;
      }
      case "golden":
        say(
          event.kind === "burst"
            ? `◆ Golden packet: +${formatShort(event.earned ?? 0)} records`
            : "◆ Golden packet: OVERCLOCK ×7 for 77 s",
        );
        break;
      case "migrate":
        say("Migrated. Fresh platform, bigger multiplier.");
        break;
      case "dropped":
        say("Some actions didn't sync with the server and were undone.");
        break;
      case "ending":
        startEnding();
        break;
      default:
        break;
    }
  });

  const restore = () => stdout.write(leaveScreen);
  process.once("exit", restore);

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));

  const quit = async () => {
    if (quitting) return;
    quitting = true;
    say("Saving…", 10_000);
    draw();
    await Promise.race([controller.save(), new Promise((r) => setTimeout(r, 4_000))]);
    resolveDone(0);
  };

  const handleKey = (key: string) => {
    if (key === "\x03" || (key === "q" && !ending)) {
      void quit();
      return;
    }
    if (ending) {
      if (ending.shown >= ENDING_LINES.length) {
        if (ending.timer) clearTimeout(ending.timer);
        ending = null;
      }
      return;
    }
    if (controller.status.kind === "stopped") {
      if (key === "r") void controller.start();
      return;
    }
    if (key !== "m") confirmMigrate = false;
    switch (key) {
      case " ":
      case "\r":
        controller.click();
        return;
      case "\t":
      case `${ESC}[C`:
        tab = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
        return;
      case `${ESC}[Z`:
      case `${ESC}[D`:
        tab = TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]!;
        return;
      case "x":
        buyAmount = BUY_AMOUNTS[(BUY_AMOUNTS.indexOf(buyAmount) + 1) % BUY_AMOUNTS.length]!;
        return;
      case "g": {
        const state = controller.local;
        if (!state) return;
        const spawn = upcomingGolden(state.golden, state.playMs);
        if (state.playMs >= spawn.at && state.playMs <= spawn.at + spawn.visibleMs) {
          controller.catchGolden(spawn.index);
        } else say("No golden packet right now. Watch for ◆.", 2_000);
        return;
      }
      case "s":
        void controller.save().then(() => {
          if (controller.status.kind === "playing") say("Saved.", 2_000);
        });
        return;
      case "m":
        if (tab !== "migrate") return;
        if (!confirmMigrate) confirmMigrate = true;
        else {
          confirmMigrate = false;
          if (!controller.migrate().ok) say("Not enough records to migrate yet.", 2_000);
        }
        return;
      case "c":
        if (tab !== "stats") return;
        void options.client
          .createPairingCode()
          .then(({ code, expiresInMs }) => {
            pairing = { code, until: Date.now() + expiresInMs };
          })
          .catch(() => say("Couldn't get a code. Try again.", 3_000));
        return;
      default:
        break;
    }
    const digit = "1234567890".indexOf(key);
    if (digit >= 0) {
      const outcome = controller.buy(digit, buyAmount);
      if (!outcome.ok && outcome.reason === "too_expensive") say("Not enough records.", 1_200);
      return;
    }
    if (tab === "upgrades" && controller.local) {
      const index = UPGRADE_KEYS.indexOf(key);
      const upgrade = index >= 0 ? listedUpgrades(controller.local)[index] : undefined;
      if (upgrade && !controller.upgrade(upgrade.id).ok) say("Not enough records.", 1_200);
    }
  };

  stdout.write(enterScreen);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  const onData = (data: string) => splitKeys(data).forEach(handleKey);
  stdin.on("data", onData);
  const onResize = () => stdout.write(`${ESC}[2J`);
  stdout.on("resize", onResize);
  const onTerm = () => void quit();
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);

  const frame = setInterval(() => {
    controller.tick();
    draw();
  }, FRAME_MS);

  await controller.start();
  if (controller.offline) {
    say(
      `While you were away (${formatDuration(controller.offline.ms)}): +${formatShort(controller.offline.earned)} records`,
      8_000,
    );
    controller.dismissOffline();
  }

  const code = await done;
  clearInterval(frame);
  stopEnding();
  stdin.off("data", onData);
  stdout.off("resize", onResize);
  process.off("SIGTERM", onTerm);
  process.off("SIGHUP", onTerm);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  restore();
  process.off("exit", restore);
  const state = controller.local;
  if (state) {
    stdout.write(
      `Saved. ${formatShort(state.lifetimeRecords)} records processed so far. See you soon.\n`,
    );
  }
  return code;
}
