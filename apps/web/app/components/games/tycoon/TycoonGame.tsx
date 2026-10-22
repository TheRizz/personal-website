import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ACHIEVEMENTS,
  AP_BONUS,
  ENDING_UPGRADE,
  GENERATORS,
  UPGRADES_BY_ID,
  affordableCount,
  availableUpgrades,
  baseRate,
  currentRate,
  formatDuration,
  formatLong,
  formatShort,
  generatorCost,
  migrationGain,
  nextPointAt,
  type GameState,
} from "@site/tycoon-core";
import { primaryButton, secondaryButton } from "~/components/games/ui";
import { TycoonController, type GameEvent, type Status } from "~/lib/games/tycoon/controller";
import { TIER_HEX } from "./colours";
import { loadSoundOn, playEvent, saveSoundOn, unlockAudio } from "./sound";

// The page: stats bar, the Phaser factory scene and the HTML shop (docs/04-pipeline-tycoon.md §1).
// Phones stack scene over a tabbed shop; wider screens put them side by side.

type Tab = "generators" | "upgrades" | "migrate" | "stats";
const TABS: { id: Tab; label: string }[] = [
  { id: "generators", label: "Build" },
  { id: "upgrades", label: "Upgrades" },
  { id: "migrate", label: "Migrate" },
  { id: "stats", label: "Stats" },
];
const BUY_AMOUNTS = [1, 10, 100] as const;
/** How often numbers on the page refresh (the scene redraws every frame on its own). */
const UI_REFRESH_MS = 125;

const subscribeNothing = () => () => {};

export function TycoonGame() {
  const [controller] = useState(() => new TycoonController());
  useSyncExternalStore(controller.subscribe, controller.getVersion, controller.getVersion);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("generators");
  const [buyAmount, setBuyAmount] = useState<(typeof BUY_AMOUNTS)[number]>(1);
  const savedSound = useSyncExternalStore(subscribeNothing, loadSoundOn, () => false);
  const [soundChoice, setSoundChoice] = useState<boolean | null>(null);
  const soundOn = soundChoice ?? savedSound;
  const [toast, setToast] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  // Start the session once; save on the way out.
  useEffect(() => {
    void controller.start();
    const leave = () => void controller.save(true);
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    const refresh = window.setInterval(() => controller.changed(), UI_REFRESH_MS);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      window.clearInterval(refresh);
      leave();
    };
  }, [controller]);

  // Phaser, loaded only in the browser and only on this page.
  const playing = controller.status.kind === "playing";
  useEffect(() => {
    const parent = sceneRef.current;
    if (!playing || !parent) return;
    let unmount: (() => void) | null = null;
    let cancelled = false;
    void import("./factory-scene.client").then(({ mountFactory }) => {
      if (!cancelled) unmount = mountFactory(parent, controller);
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [playing, controller]);

  // Sounds, toasts and the ending.
  useEffect(() => {
    let timer: number | undefined;
    const show = (text: string) => {
      setToast(text);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(null), 3_500);
    };
    const off = controller.onEvent((event: GameEvent) => {
      if (soundOn) playEvent(event);
      if (event.type === "achievement") {
        const names = event.ids.map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.name ?? id);
        show(`Achievement: ${names.join(", ")} (+1 %)`);
      }
      if (event.type === "dropped")
        show("Some actions didn't sync with the server and were undone.");
      if (event.type === "ending") setEnding(true);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [controller, soundOn]);

  const state = controller.local;

  function toggleSound() {
    const next = !soundOn;
    if (next) unlockAudio();
    saveSoundOn(next);
    setSoundChoice(next);
  }

  function onSceneKey(event: React.KeyboardEvent) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) controller.click();
    }
    const digit = "1234567890".indexOf(event.key);
    if (digit >= 0 && state) {
      const count = Math.min(buyAmount, affordableCount(state, digit, buyAmount));
      if (count > 0) controller.buy(digit, count);
    }
  }

  return (
    <div
      className="relative mx-[calc((100%-min(68.75rem,100cqw-1rem))/2)] w-[min(68.75rem,100cqw-1rem)]"
      data-testid="tycoon"
    >
      <StatsBar
        state={state}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        saving={controller.saving}
      />

      <div className="flex h-[calc(100dvh-9rem)] min-h-[34rem] flex-col overflow-hidden rounded-xl border border-line lg:grid lg:h-[40rem] lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-1">
        <div
          ref={sceneRef}
          role="button"
          tabIndex={0}
          aria-label="Factory. Press space to process records, number keys to build."
          onKeyDown={onSceneKey}
          onPointerDown={() => soundOn && unlockAudio()}
          className="relative min-h-0 flex-[0_0_44%] touch-manipulation bg-[#07090c] outline-none select-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 lg:h-full"
        >
          {toast && (
            <p
              role="status"
              className="pointer-events-none absolute inset-x-3 bottom-3 z-10 rounded-lg border border-cyan-300/30 bg-black/80 px-3 py-2 font-mono text-xs text-cyan-100"
            >
              {toast}
            </p>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-line lg:border-t-0 lg:border-l">
          <div role="tablist" aria-label="Shop" className="flex shrink-0 border-b border-line">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className="flex-1 px-2 py-2.5 text-sm font-semibold text-muted transition-colors aria-selected:bg-surface aria-selected:text-fg hover:text-fg"
              >
                {label}
                {id === "upgrades" && state && <UpgradeBadge state={state} />}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {!state ? (
              <p className="p-4 font-mono text-sm text-muted">Connecting…</p>
            ) : tab === "generators" ? (
              <GeneratorList
                controller={controller}
                state={state}
                buyAmount={buyAmount}
                setBuyAmount={setBuyAmount}
              />
            ) : tab === "upgrades" ? (
              <UpgradeList controller={controller} state={state} />
            ) : tab === "migrate" ? (
              <MigratePanel controller={controller} state={state} />
            ) : (
              <StatsPanel controller={controller} state={state} />
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 text-[0.8rem] text-muted">
        Click the core (or focus it and press space) to process records. Keys 1–0 build. Progress is
        saved to the server every few minutes and when you leave.
      </p>

      {controller.offline && state && (
        <Overlay>
          <p className="font-mono text-xs tracking-widest text-cyan-300 uppercase">
            While you were away
          </p>
          <p className="mt-3 text-lg">
            Your pipelines ran for <strong>{formatDuration(controller.offline.ms)}</strong> and
            processed{" "}
            <strong className="font-mono">{formatShort(controller.offline.earned)}</strong> records.
          </p>
          {controller.offline.ms >= 8 * 3_600_000 && (
            <p className="mt-2 text-sm text-muted">Offline progress is capped at 8 hours.</p>
          )}
          <button className={`${primaryButton} mt-5`} onClick={() => controller.dismissOffline()}>
            Back to work
          </button>
        </Overlay>
      )}

      {controller.status.kind === "stopped" && (
        <StoppedOverlay status={controller.status} onRetry={() => void controller.start()} />
      )}

      {ending && <EndingOverlay onClose={() => setEnding(false)} />}
    </div>
  );
}

function StatsBar({
  state,
  soundOn,
  onToggleSound,
  saving,
}: {
  state: GameState | null;
  soundOn: boolean;
  onToggleSound: () => void;
  saving: boolean;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-[0.75rem] tracking-widest text-muted uppercase">Records</p>
        <p
          className="truncate font-mono text-3xl leading-tight font-bold tabular-nums"
          aria-live="off"
        >
          {state ? formatShort(state.records) : "—"}
        </p>
        <p className="font-mono text-sm text-muted tabular-nums">
          {state ? `${formatShort(currentRate(state))}/s` : " "}
          {state && state.ap > 0 && <span className="ml-3 text-violet-300">{state.ap} AP</span>}
          {saving && <span className="ml-3 text-cyan-300/80">saving…</span>}
        </p>
      </div>
      <button
        onClick={onToggleSound}
        aria-pressed={soundOn}
        aria-label={soundOn ? "Mute sound" : "Turn sound on"}
        className={secondaryButton}
      >
        {soundOn ? <Volume2 /> : <VolumeX />}
      </button>
    </div>
  );
}

function UpgradeBadge({ state }: { state: GameState }) {
  const affordable = availableUpgrades(state).filter((u) => u.cost <= state.records).length;
  if (affordable === 0) return null;
  return (
    <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 font-mono text-[0.7rem] text-cyan-200">
      {affordable}
    </span>
  );
}

function GeneratorList({
  controller,
  state,
  buyAmount,
  setBuyAmount,
}: {
  controller: TycoonController;
  state: GameState;
  buyAmount: number;
  setBuyAmount: (n: (typeof BUY_AMOUNTS)[number]) => void;
}) {
  // Owned tiers, plus the next two, so there's always something to aim for.
  const highest = state.owned.reduce((top, n, i) => (n > 0 ? i : top), -1);
  const visible = GENERATORS.slice(0, Math.min(GENERATORS.length, highest + 3));
  return (
    <>
      <div
        className="mb-2 flex items-center justify-end gap-1"
        role="group"
        aria-label="Buy amount"
      >
        {BUY_AMOUNTS.map((amount) => (
          <button
            key={amount}
            aria-pressed={buyAmount === amount}
            onClick={() => setBuyAmount(amount)}
            className="rounded-md px-2 py-0.5 font-mono text-xs text-muted aria-pressed:bg-surface-hover aria-pressed:text-fg"
          >
            ×{amount}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {visible.map((generator, tier) => {
          const owned = state.owned[tier] ?? 0;
          const cost = generatorCost(state, tier, buyAmount);
          const canBuy = cost <= state.records;
          const known = owned > 0 || tier <= highest + 1;
          return (
            <li key={generator.id}>
              <button
                disabled={!canBuy}
                onClick={() => controller.buy(tier, buyAmount)}
                className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left transition hover:bg-surface-hover active:scale-[0.99] disabled:opacity-55"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: TIER_HEX[tier], boxShadow: `0 0 8px ${TIER_HEX[tier]}` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.95rem] font-semibold">
                      {known ? generator.name : "???"}
                    </span>
                    <span className="font-mono text-sm text-muted tabular-nums">{owned}</span>
                  </span>
                  <span className="block truncate text-[0.78rem] leading-snug text-muted">
                    {known ? generator.blurb : "Keep building to find out."}
                  </span>
                  <span className="font-mono text-[0.78rem] tabular-nums">
                    <span className={canBuy ? "text-cyan-200" : "text-muted"}>
                      {formatShort(cost)}
                    </span>
                    <span className="text-muted"> · key {(tier + 1) % 10}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function UpgradeList({ controller, state }: { controller: TycoonController; state: GameState }) {
  const upgrades = availableUpgrades(state).sort((a, b) => a.cost - b.cost);
  if (upgrades.length === 0) {
    return (
      <p className="p-2 text-sm text-muted">
        Nothing new yet. Upgrades unlock as you build and click.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {upgrades.map((upgrade) => {
        const canBuy = upgrade.cost <= state.records;
        const ending = upgrade.id === ENDING_UPGRADE;
        return (
          <li key={upgrade.id}>
            <button
              disabled={!canBuy}
              onClick={() => controller.upgrade(upgrade.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition hover:bg-surface-hover active:scale-[0.99] disabled:opacity-55 ${
                ending ? "border-amber-300/60 bg-amber-300/5" : "border-line"
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[0.95rem] font-semibold">{upgrade.name}</span>
                <span
                  className={`font-mono text-sm tabular-nums ${canBuy ? "text-cyan-200" : "text-muted"}`}
                >
                  {formatShort(upgrade.cost)}
                </span>
              </span>
              <span className="block text-[0.8rem] leading-snug text-muted">{upgrade.blurb}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MigratePanel({ controller, state }: { controller: TycoonController; state: GameState }) {
  const [confirming, setConfirming] = useState(false);
  const gain = migrationGain(state);
  const next = nextPointAt(state);
  const progress = Math.min(1, state.runRecords / next);
  return (
    <div className="p-1 text-[0.92rem] leading-relaxed">
      <h3 className="text-lg font-bold">Platform Migration</h3>
      <p className="mt-1 text-muted">
        Throw out the whole stack and rebuild on a new platform. You lose your records, generators
        and upgrades, and earn <strong className="text-fg">Architecture Points</strong>: each one is
        a permanent +{Math.round(AP_BONUS * 100)} % to all production. Achievements stay.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-y-1 font-mono text-sm">
        <dt className="text-muted">You have</dt>
        <dd className="text-right">{state.ap} AP</dd>
        <dt className="text-muted">Migrating now gives</dt>
        <dd className="text-right text-violet-300">+{gain} AP</dd>
        <dt className="text-muted">This run</dt>
        <dd className="text-right">{formatShort(state.runRecords)}</dd>
      </dl>
      <div className="mt-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden="true">
          <div className="h-full bg-violet-400" style={{ width: `${progress * 100}%` }} />
        </div>
        <p className="mt-1 font-mono text-xs text-muted">
          Next point at {formatShort(next)} records this run
        </p>
      </div>
      {confirming ? (
        <div className="mt-4 flex gap-2">
          <button
            className={primaryButton}
            onClick={() => {
              controller.migrate();
              setConfirming(false);
            }}
          >
            Migrate for {gain} AP
          </button>
          <button className={secondaryButton} onClick={() => setConfirming(false)}>
            Not yet
          </button>
        </div>
      ) : (
        <button
          className={`${secondaryButton} mt-4`}
          disabled={gain < 1}
          onClick={() => setConfirming(true)}
        >
          {gain < 1 ? "Not enough records yet" : "Start migration…"}
        </button>
      )}
    </div>
  );
}

function StatsPanel({ controller, state }: { controller: TycoonController; state: GameState }) {
  const unlocked = new Set(state.achievements);
  const rows: [string, string][] = [
    ["Records ever", formatLong(state.lifetimeRecords)],
    ["Base production", `${formatShort(baseRate(state))}/s`],
    ["Play time", formatDuration(state.playMs)],
    ["This run", formatDuration(state.runMs)],
    ["Clicks", state.clicks.toLocaleString("en-US")],
    ["Golden packets", state.goldenCaught.toLocaleString("en-US")],
    ["Migrations", state.migrations.toLocaleString("en-US")],
    ["Upgrades owned", `${state.upgrades.filter((id) => UPGRADES_BY_ID.has(id)).length}`],
  ];
  return (
    <div className="p-1">
      <dl className="grid grid-cols-2 gap-y-1 font-mono text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2 font-mono text-xs text-muted">
        <span>
          {controller.lastSavedAt
            ? `Saved at ${new Date(controller.lastSavedAt).toLocaleTimeString()}`
            : "Not saved yet this visit"}
        </span>
        <button
          className="rounded-md border border-line px-2 py-1 text-fg hover:bg-surface-hover disabled:opacity-50"
          disabled={controller.saving}
          onClick={() => void controller.save()}
        >
          Save now
        </button>
      </div>
      <h3 className="mt-5 mb-2 text-sm font-semibold">
        Achievements {state.achievements.length}/{ACHIEVEMENTS.length}
      </h3>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-1">
        {ACHIEVEMENTS.map((achievement) => {
          const has = unlocked.has(achievement.id);
          return (
            <li
              key={achievement.id}
              className={`rounded-md border px-2 py-1 text-[0.8rem] leading-snug ${
                has ? "border-cyan-300/30 text-fg" : "border-line text-muted/70"
              }`}
            >
              <span className="font-semibold">{has ? achievement.name : "???"}</span>
              <span className="block text-muted">{achievement.blurb}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Overlay({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${dark ? "bg-black" : "bg-black/70 backdrop-blur-sm"}`}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-bg p-6 text-fg shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function StoppedOverlay({
  status,
  onRetry,
}: {
  status: Extract<Status, { kind: "stopped" }>;
  onRetry: () => void;
}) {
  const { failure } = status;
  const message =
    failure.kind === "session_replaced"
      ? "You're playing on another tab or device. Only one can save at a time."
      : failure.kind === "update_required"
        ? "Pipeline Tycoon has been updated. Reload to get the new version."
        : failure.kind === "out_of_sync"
          ? "This tab fell out of sync with your save."
          : failure.kind === "rate_limited"
            ? "Too many new players from your network right now. Try again in a minute."
            : "Couldn't reach the server.";
  return (
    <Overlay>
      <p className="font-mono text-xs tracking-widest text-amber-300 uppercase">Pipeline halted</p>
      <p className="mt-3 text-lg">{message}</p>
      <div className="mt-5 flex gap-2">
        <button
          className={primaryButton}
          onClick={failure.kind === "update_required" ? () => window.location.reload() : onRetry}
        >
          {failure.kind === "update_required" ? "Reload" : "Continue here"}
        </button>
      </div>
    </Overlay>
  );
}

const TERMINAL_LINES = [
  "> integrate --target=earth",
  "[ok] 8,100,000,000 humans … synced",
  "[ok] 17,000,000,000 devices … synced",
  "[ok] every toaster on the planet … synced",
  "[ok] all data on Earth has been integrated.",
  "",
  "INCOMING CONNECTION REQUEST — ORIGIN: UNKNOWN — PROTOCOL: UNRECOGNIZED",
];

/** The soft ending: a victory card, then the terminal and the request you can't accept (yet). */
function EndingOverlay({ onClose }: { onClose: () => void }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= TERMINAL_LINES.length) return;
    const timer = window.setTimeout(
      () => setShown((n) => n + 1),
      shown === 0 ? 2_500 : shown === 5 ? 2_200 : 700,
    );
    return () => window.clearTimeout(timer);
  }, [shown]);
  const done = shown >= TERMINAL_LINES.length;
  return (
    <Overlay dark>
      <p className="font-mono text-xs tracking-widest text-cyan-300 uppercase">
        Integration complete
      </p>
      <h2 className="mt-2 text-2xl font-bold">You integrated Earth.</h2>
      <p className="mt-2 text-muted">There is nothing left to connect.</p>
      <pre className="mt-5 min-h-[11rem] overflow-x-auto rounded-lg border border-line bg-black p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap text-cyan-100">
        {TERMINAL_LINES.slice(0, shown).map((line, i) => (
          <span
            key={i}
            className={
              i === TERMINAL_LINES.length - 1 ? "block animate-pulse text-rose-300" : "block"
            }
          >
            {line || " "}
          </span>
        ))}
      </pre>
      {done && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            disabled
            title="Unavailable"
            className="cursor-not-allowed rounded-lg border border-line px-4 py-2 font-mono text-sm text-muted/60"
          >
            [ACCEPT] (unavailable)
          </button>
          <button className={secondaryButton} onClick={onClose}>
            Keep playing
          </button>
        </div>
      )}
    </Overlay>
  );
}
