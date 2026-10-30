import { Settings, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BONUS,
  AP_BONUS,
  ENDING_UPGRADE,
  GENERATORS,
  UPGRADES_BY_ID,
  affordableCount,
  availableUpgrades,
  baseRate,
  clickValue,
  currentRate,
  formatDuration,
  formatLong,
  describeUndone,
  generatorCost,
  maxAffordable,
  migrationGain,
  nextMilestone,
  nextPointAt,
  achievementProgress,
  secondsToAfford,
  tierRate,
  tierShare,
  TycoonController,
  type GameEvent,
  type GameState,
  type Status,
} from "@site/tycoon-core";
import { primaryButton, secondaryButton } from "~/components/games/ui";
import { tycoonClient } from "~/lib/games/tycoon/api";
import { TIER_HEX } from "./colours";
import {
  HINTS,
  dueHint,
  isReturning,
  loadSeenHints,
  saveSeenHints,
  type Hint,
  type HintId,
} from "./hints";
import { LinkDevice } from "./LinkDevice";
import { SettingsSheet } from "./SettingsSheet";
import { getSettings, updateSettings, useFormat, useSettings } from "./settings";
import { playEvent, unlockAudio } from "./sound";

// The page: stats bar, the Phaser factory scene and the HTML shop (docs/04-pipeline-tycoon.md §1).
// Phones stack scene over a tabbed shop; wider screens put them side by side.

type Tab = "generators" | "upgrades" | "migrate" | "stats";
const TABS: { id: Tab; label: string }[] = [
  { id: "generators", label: "Build" },
  { id: "upgrades", label: "Upgrades" },
  { id: "migrate", label: "Migrate" },
  { id: "stats", label: "Stats" },
];
const BUY_AMOUNTS = [1, 10, 100, "max"] as const;
type BuyAmount = (typeof BUY_AMOUNTS)[number];
/** The rules take at most 100 of a tier per action, so bigger buys go in chunks. */
const MAX_PER_ACTION = 100;
/** How often numbers on the page refresh (the scene redraws every frame on its own). */
const UI_REFRESH_MS = 125;
const TOAST_MS = 3_500;
/** First-time tips stay up a little longer than other toasts. */
const HINT_MS = 5_000;

/** How many of a tier one press buys: the chosen amount, or whatever the bank allows for Max. */
function buyCount(state: GameState, tier: number, amount: BuyAmount): number {
  return amount === "max" ? maxAffordable(state, tier) : amount;
}

function buyMany(controller: TycoonController, tier: number, count: number) {
  for (let left = count; left > 0; left -= MAX_PER_ACTION) {
    if (!controller.buy(tier, Math.min(MAX_PER_ACTION, left)).ok) break;
  }
}

/** "in 14s", "in 2m", or nothing when it's affordable now or never at today's rate. */
function waitLabel(state: GameState, cost: number): string | null {
  const seconds = secondsToAfford(state, cost);
  if (seconds === null || seconds === 0) return null;
  return `in ${formatDuration(Math.ceil(seconds) * 1000)}`;
}

export function TycoonGame() {
  const [controller] = useState(() => new TycoonController(tycoonClient));
  useSyncExternalStore(controller.subscribe, controller.getVersion, controller.getVersion);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("generators");
  const [buyAmount, setBuyAmount] = useState<BuyAmount>(1);
  const newVersion = useNewVersion();
  const { sound: soundOn } = useSettings();
  const fmt = useFormat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  // Start the session once; save on the way out, and catch up on the way back (a phone may have
  // suspended the page before that save heard back).
  useEffect(() => {
    void controller.start();
    const leave = () => void controller.save(true);
    const back = () => controller.resume();
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
      else back();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    document.addEventListener("visibilitychange", hidden);
    const refresh = window.setInterval(() => controller.changed(), UI_REFRESH_MS);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
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
      if (!cancelled) unmount = mountFactory(parent, controller, getSettings);
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [playing, controller]);

  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((text: string, ms = TOAST_MS) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const hideToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Sounds, toasts and the ending.
  useEffect(() => {
    const off = controller.onEvent((event: GameEvent) => {
      if (soundOn) playEvent(event);
      if (event.type === "achievement") {
        const names = event.ids.map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.name ?? id);
        showToast(`Achievement: ${names.join(", ")} (+1 %)`);
      }
      if (event.type === "dropped") showToast(describeUndone(event.undone));
      if (event.type === "ending") setEnding(true);
    });
    return off;
  }, [controller, soundOn, showToast]);

  const state = controller.local;

  // First-time tips, one at a time when nothing else is on show. A game that already has
  // progress when the page opens counts every tip as seen. A tip goes as soon as it has been
  // followed ("Tap the core" on the first tap), rather than covering the scene for its full time.
  const seenHints = useRef<Set<HintId> | null>(null);
  const shownHint = useRef<Hint | null>(null);
  useEffect(() => {
    if (!state || !playing) return;
    if (shownHint.current && toast !== shownHint.current.text) shownHint.current = null;
    if (shownHint.current && !shownHint.current.due(state)) {
      shownHint.current = null;
      hideToast();
      return;
    }
    if (!seenHints.current) {
      seenHints.current = loadSeenHints();
      if (isReturning(state) && seenHints.current.size < HINTS.length) {
        HINTS.forEach((hint) => seenHints.current!.add(hint.id));
        saveSeenHints(seenHints.current);
      }
    }
    if (toast || controller.offline) return;
    const hint = dueHint(state, seenHints.current);
    if (!hint) return;
    seenHints.current.add(hint.id);
    saveSeenHints(seenHints.current);
    shownHint.current = hint;
    showToast(hint.text, HINT_MS);
  });

  function toggleSound() {
    const next = !soundOn;
    if (next) unlockAudio();
    updateSettings({ sound: next });
  }

  function onSceneKey(event: React.KeyboardEvent) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) controller.click();
    }
    const digit = "1234567890".indexOf(event.key);
    if (digit >= 0 && state) {
      const count =
        buyAmount === "max"
          ? maxAffordable(state, digit)
          : Math.min(buyAmount, affordableCount(state, digit, buyAmount));
      if (count > 0) buyMany(controller, digit, count);
    }
  }

  // touch-manipulation: quick taps on the shop buy things instead of zooming the page (iOS).
  return (
    <div
      className="relative mx-[calc((100%-min(68.75rem,100cqw-1rem))/2)] w-[min(68.75rem,100cqw-1rem)] touch-manipulation"
      data-testid="tycoon"
    >
      {newVersion && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3"
        >
          <p className="text-[0.95rem]">A new version of Pipeline Tycoon is out.</p>
          <button
            className={secondaryButton}
            disabled={controller.saving}
            onClick={() => void controller.save().finally(() => window.location.reload())}
          >
            Save and reload
          </button>
        </div>
      )}

      <StatsBar
        state={state}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        onOpenSettings={() => setSettingsOpen(true)}
        saving={controller.saving}
      />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

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
                {id === "migrate" && state && migrationGain(state) >= 1 && (
                  <span
                    className="ml-1.5 inline-block size-2 rounded-full bg-accent-violet align-middle"
                    aria-label="(ready)"
                  />
                )}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {!state ? (
              <p className="p-4 text-sm text-muted">Connecting…</p>
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
        <span className="pointer-coarse:hidden">
          Click the core (or focus it and press space) to process records. Keys 1–0 build.
        </span>
        <span className="hidden pointer-coarse:inline">
          Tap the core to process records; two thumbs work too.
        </span>{" "}
        Progress is saved to the server every few minutes and when you leave.
      </p>

      {controller.offline && state && (
        <Overlay>
          <h2 className="text-xl font-bold">While you were away</h2>
          <p className="mt-2 text-lg">
            Your pipelines ran for <strong>{formatDuration(controller.offline.ms)}</strong> and
            processed <strong className="tabular-nums">{fmt(controller.offline.earned)}</strong>{" "}
            records.
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
  onOpenSettings,
  saving,
}: {
  state: GameState | null;
  soundOn: boolean;
  onToggleSound: () => void;
  onOpenSettings: () => void;
  saving: boolean;
}) {
  const fmt = useFormat();
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <p
          className="truncate text-4xl leading-none font-bold tracking-[-0.02em] tabular-nums"
          aria-live="off"
          data-testid="records"
        >
          {state ? fmt(state.records) : "—"}
        </p>
        <p className="mt-1 text-sm text-muted tabular-nums">
          records{state ? ` · ${fmt(currentRate(state))} a second` : ""}
          {state && state.ap > 0 && <span className="ml-3 text-accent-violet">{state.ap} AP</span>}
          {saving && <span className="ml-3 text-accent/80">saving…</span>}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {/* On phones sound lives in the settings sheet, to keep the bar to one button. */}
        <button
          onClick={onToggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? "Mute sound" : "Turn sound on"}
          className={`${secondaryButton} max-sm:hidden`}
        >
          {soundOn ? <Volume2 /> : <VolumeX />}
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          aria-haspopup="dialog"
          className={secondaryButton}
        >
          <Settings />
        </button>
      </div>
    </div>
  );
}

function UpgradeBadge({ state }: { state: GameState }) {
  const affordable = availableUpgrades(state).filter((u) => u.cost <= state.records).length;
  if (affordable === 0) return null;
  return (
    <span className="ml-1.5 rounded-full bg-accent/15 px-1.5 text-[0.7rem] font-semibold text-accent tabular-nums">
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
  buyAmount: BuyAmount;
  setBuyAmount: (n: BuyAmount) => void;
}) {
  const fmt = useFormat();
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
            className="rounded-md px-2.5 py-1 text-xs font-semibold text-muted tabular-nums transition-colors hover:text-fg aria-pressed:bg-surface-hover aria-pressed:text-fg"
          >
            {amount === "max" ? "Max" : `×${amount}`}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {visible.map((generator, tier) => {
          const owned = state.owned[tier] ?? 0;
          const count = buyCount(state, tier, buyAmount);
          // Max with nothing affordable shows the price of one, greyed out.
          const cost = generatorCost(state, tier, Math.max(1, count));
          const canBuy = count > 0 && cost <= state.records;
          const known = owned > 0 || tier <= highest + 1;
          const wait = canBuy ? null : waitLabel(state, cost);
          const milestone = nextMilestone(state, tier);
          const share = tierShare(state, tier);
          return (
            <li key={generator.id}>
              <button
                disabled={!canBuy}
                onClick={() => buyMany(controller, tier, count)}
                className="flex w-full items-center gap-3 rounded-lg bg-surface/60 px-3 py-2 text-left transition hover:bg-surface-hover active:scale-[0.99] disabled:opacity-55"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: TIER_HEX[tier] }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.95rem] font-semibold">
                      {known ? generator.name : "???"}
                    </span>
                    <span
                      className="text-sm font-semibold tabular-nums"
                      aria-label={`${owned} owned`}
                    >
                      {owned}
                    </span>
                  </span>
                  <span className="block truncate text-[0.8rem] leading-snug text-muted">
                    {known ? generator.blurb : "Keep building to find out."}
                  </span>
                  <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[0.8rem] tabular-nums">
                    <span>
                      <span className={canBuy ? "font-semibold text-accent" : "text-muted"}>
                        {buyAmount === "max" && count > 1 ? `${count} for ` : ""}
                        {fmt(cost)}
                      </span>
                      {wait && <span className="text-muted"> · {wait}</span>}
                    </span>
                    {owned > 0 && (
                      <span className="truncate text-muted">
                        {fmt(tierRate(state, tier))}/s · {Math.round(share * 100)} %
                      </span>
                    )}
                  </span>
                  {milestone !== null && owned > 0 && (
                    <span className="mt-1 flex items-center gap-2 text-[0.72rem] text-muted tabular-nums">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (owned / milestone) * 100)}%`,
                            background: TIER_HEX[tier],
                          }}
                        />
                      </span>
                      <span>
                        {owned}/{milestone} unlocks ×2
                      </span>
                    </span>
                  )}
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
  const fmt = useFormat();
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
        const wait = canBuy ? null : waitLabel(state, upgrade.cost);
        return (
          <li key={upgrade.id}>
            <button
              disabled={!canBuy}
              onClick={() => controller.upgrade(upgrade.id)}
              className={`w-full rounded-lg px-3 py-2 text-left transition hover:bg-surface-hover active:scale-[0.99] disabled:opacity-55 ${
                ending ? "bg-warn/10" : "bg-surface/60"
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[0.95rem] font-semibold">{upgrade.name}</span>
                <span
                  className={`text-sm tabular-nums ${canBuy ? "font-semibold text-accent" : "text-muted"}`}
                >
                  {fmt(upgrade.cost)}
                </span>
              </span>
              <span className="block text-[0.8rem] leading-snug text-muted">{upgrade.blurb}</span>
              {wait && <span className="block text-[0.75rem] text-muted tabular-nums">{wait}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MigratePanel({ controller, state }: { controller: TycoonController; state: GameState }) {
  const fmt = useFormat();
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
      <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted">You have</dt>
        <dd className="text-right">{state.ap} AP</dd>
        <dt className="text-muted">Migrating now gives</dt>
        <dd className="text-right text-accent-violet">+{gain} AP</dd>
        <dt className="text-muted">This run</dt>
        <dd className="text-right">{fmt(state.runRecords)}</dd>
      </dl>
      <div className="mt-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden="true">
          <div className="h-full bg-accent-violet" style={{ width: `${progress * 100}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted tabular-nums">
          Next point at {fmt(next)} records this run
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
  const fmt = useFormat();
  const unlocked = new Set(state.achievements);
  const rows: [string, string][] = [
    ["Records ever", formatLong(state.lifetimeRecords)],
    ["Base production", `${fmt(baseRate(state))}/s`],
    ["Best production", `${fmt(state.bestRate)}/s`],
    ["Per click", fmt(clickValue(state))],
    [
      "Permanent bonus",
      `+${Math.round((AP_BONUS * state.ap + ACHIEVEMENT_BONUS * state.achievements.length) * 100)} %`,
    ],
    ["Play time", formatDuration(state.playMs)],
    ["This run", formatDuration(state.runMs)],
    ["Clicks", state.clicks.toLocaleString("en-US")],
    ["Golden packets", state.goldenCaught.toLocaleString("en-US")],
    ["Migrations", state.migrations.toLocaleString("en-US")],
    ["Upgrades owned", `${state.upgrades.filter((id) => UPGRADES_BY_ID.has(id)).length}`],
  ];
  return (
    <div className="p-1">
      <dl className="grid grid-cols-2 gap-y-1 text-sm tabular-nums">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
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
      <LinkDevice controller={controller} />
      <h3 className="mt-5 mb-2 text-sm font-semibold">
        Achievements {state.achievements.length}/{ACHIEVEMENTS.length}
      </h3>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-1">
        {ACHIEVEMENTS.map((achievement) => {
          const has = unlocked.has(achievement.id);
          const progress = has ? null : achievementProgress(state, achievement);
          return (
            <li
              key={achievement.id}
              className={`rounded-md px-2 py-1.5 text-[0.8rem] leading-snug ${
                has ? "bg-accent/10 text-fg" : "bg-surface/60 text-muted"
              }`}
            >
              <span className="font-semibold">{has ? achievement.name : "???"}</span>
              <span className="block text-muted">{achievement.blurb}</span>
              {progress && (
                <span className="mt-1 flex items-center gap-2 text-[0.72rem] tabular-nums">
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${Math.min(100, (progress.current / progress.target) * 100)}%`,
                      }}
                    />
                  </span>
                  <span>
                    {fmt(Math.min(progress.current, progress.target))}/{fmt(progress.target)}
                  </span>
                </span>
              )}
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
      <h2 className="text-xl font-bold">Pipeline halted</h2>
      <p className="mt-2 text-lg">{message}</p>
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
      <h2 className="text-2xl font-bold">You integrated Earth.</h2>
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

declare const __APP_VERSION__: string | undefined;

/** How often an open tab asks whether a newer build is live (also on coming back to the tab). */
const VERSION_CHECK_MS = 10 * 60_000;

/**
 * True once /api/health reports a different build from the one this tab runs. iPhone keeps tabs
 * alive for days, so without this an old tab can play old code long after a deploy.
 */
function useNewVersion(): boolean {
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    const mine = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
    if (!mine || outdated) return;
    let last = 0;
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < VERSION_CHECK_MS) return;
      last = Date.now();
      fetch("/api/health", { cache: "no-store" })
        .then((response) =>
          response.ok ? (response.json() as Promise<{ version?: unknown }>) : null,
        )
        .then((body) => {
          if (typeof body?.version === "string" && body.version !== mine) setOutdated(true);
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, VERSION_CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [outdated]);
  return outdated;
}
