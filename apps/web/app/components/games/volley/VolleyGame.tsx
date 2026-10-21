import { Pause, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { card, eyebrow, ghostButton, primaryButton, secondaryButton } from "~/components/games/ui";
import { CpuPlayer } from "~/lib/games/volley/ai";
import { CHARACTERS } from "~/lib/games/volley/characters";
import {
  COURT_H,
  COURT_W,
  STEP,
  createMatch,
  step,
  type Input,
  type Match,
} from "~/lib/games/volley/engine";
import {
  COURTS,
  LEVELS,
  MODES,
  TARGETS,
  charactersFor,
  controllers,
  hasPlayerTwo,
  parseSetup,
  sideNames,
  type Setup,
} from "~/lib/games/volley/setup";
import { Controls, GAME_KEYS } from "./controls";
import { drawMatch, rallyBanner } from "./render";
import { playEvent, unlockAudio } from "./sound";
import { TouchControls } from "./TouchControls";

const SETUP_KEY = "games.volley.setup";
const MUTED_KEY = "games.volley.muted";

function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; fine for this visit.
  }
}

const subscribeNothing = () => () => {};

function parseSaved(json: string | null): Setup {
  try {
    return parseSetup(JSON.parse(json ?? "null"));
  } catch {
    return parseSetup(null);
  }
}

/** Whether the device's main pointer is a finger. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(pointer: coarse)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

/** The setup screen, then the match full screen until the player leaves it. */
export function VolleyGame() {
  // The last setup, remembered in localStorage; the default until hydration.
  const saved = useSyncExternalStore(
    subscribeNothing,
    () => load(SETUP_KEY),
    () => null,
  );
  const [draft, setDraft] = useState<Setup | null>(null);
  const setup = useMemo(() => draft ?? parseSaved(saved), [draft, saved]);
  const [playing, setPlaying] = useState(false);

  function update(change: Partial<Setup>) {
    const next = parseSetup({ ...setup, ...change });
    save(SETUP_KEY, JSON.stringify(next));
    setDraft(next);
  }

  if (playing) return <MatchScreen setup={setup} onQuit={() => setPlaying(false)} />;
  return (
    <SetupScreen
      setup={setup}
      update={update}
      onStart={() => {
        unlockAudio();
        setPlaying(true);
      }}
    />
  );
}

function Choice<T extends string | number>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className={`${eyebrow} mb-2`}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label key={option.value} className="relative">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-line bg-bg px-4 text-[0.95rem] font-semibold text-muted transition peer-checked:border-fg peer-checked:bg-fg peer-checked:text-bg peer-focus-visible:ring-2 peer-focus-visible:ring-fg/40 hover:text-fg">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CharacterPicker({
  legend,
  name,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend className={`${eyebrow} mb-2`}>{legend}</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {CHARACTERS.map((character) => (
          <label key={character.id} className="relative">
            <input
              type="radio"
              name={name}
              value={character.id}
              checked={character.id === value}
              onChange={() => onChange(character.id)}
              className="peer sr-only"
            />
            <span className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-line bg-bg px-2 py-2.5 text-sm font-semibold text-muted transition peer-checked:border-fg peer-checked:text-fg peer-focus-visible:ring-2 peer-focus-visible:ring-fg/40 hover:text-fg">
              <svg viewBox="0 0 40 36" aria-hidden="true" className="h-8 w-9">
                <ellipse
                  cx="20"
                  cy="19"
                  rx="17"
                  ry="16"
                  fill={character.color}
                  stroke={character.shade}
                  strokeWidth="2.5"
                />
                <circle cx="14" cy="14" r="3.6" fill="#fff" />
                <circle cx="26" cy="14" r="3.6" fill="#fff" />
                <circle cx="15" cy="14.5" r="1.8" fill="#0f172a" />
                <circle cx="27" cy="14.5" r="1.8" fill="#0f172a" />
              </svg>
              {character.name}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SetupScreen({
  setup,
  update,
  onStart,
}: {
  setup: Setup;
  update: (change: Partial<Setup>) => void;
  onStart: () => void;
}) {
  const two = hasPlayerTwo(setup);
  const anyCpu = controllers(setup).includes("cpu");
  const modes = MODES[setup.format];
  // The page is prerendered: until the game's code has loaded, a tap on Start would do nothing.
  const ready = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  return (
    <div className="space-y-4">
      <div className={`${card} space-y-6`}>
        <Choice
          legend="Format"
          name="format"
          value={setup.format}
          options={[
            { value: "1v1", label: "1 vs 1" },
            { value: "2v2", label: "2 vs 2" },
          ]}
          onChange={(format) => update({ format, mode: "cpu" })}
        />
        <div>
          <Choice
            legend="Players"
            name="mode"
            value={setup.mode}
            options={modes.map((entry) => ({ value: entry.mode, label: entry.label }))}
            onChange={(mode) => update({ mode })}
          />
          <p className="mt-2 text-sm text-muted">
            {modes.find((entry) => entry.mode === setup.mode)?.hint}
          </p>
        </div>
        {anyCpu && (
          <Choice
            legend="Computer"
            name="level"
            value={setup.level}
            options={LEVELS.map((level) => ({
              value: level,
              label: level[0]!.toUpperCase() + level.slice(1),
            }))}
            onChange={(level) => update({ level })}
          />
        )}
        <div>
          <Choice
            legend="Court"
            name="court"
            value={setup.court}
            options={COURTS.map((court) => ({ value: court.id, label: court.label }))}
            onChange={(court) => update({ court })}
          />
          {setup.court === "jungle" && (
            <p className="mt-2 text-sm text-muted">
              A monkey walks along the roof. Pass him the ball and he spikes it at the other side.
            </p>
          )}
        </div>
        <Choice
          legend="Points to win"
          name="target"
          value={setup.target}
          options={TARGETS.map((target) => ({ value: target, label: String(target) }))}
          onChange={(target) => update({ target })}
        />
        <CharacterPicker
          legend={two ? "Player 1" : "Your player"}
          name="p1"
          value={setup.p1}
          onChange={(p1) => update({ p1 })}
        />
        {two && (
          <CharacterPicker
            legend="Player 2"
            name="p2"
            value={setup.p2}
            onChange={(p2) => update({ p2 })}
          />
        )}
        <button
          type="button"
          onClick={onStart}
          disabled={!ready}
          className={`${primaryButton} w-full`}
        >
          <Play aria-hidden="true" />
          Start match
        </button>
      </div>

      <section
        aria-labelledby="how-to-play"
        className="space-y-2 pt-2 text-sm leading-relaxed text-muted"
      >
        <h2 id="how-to-play" className={eyebrow}>
          How to play
        </h2>
        <p>
          Hit the ball by running and jumping into it. The serve floats still above the server, who
          gets one touch to send it over. After that each side gets three touches. Only the serving
          side scores: win a rally when the other side served and you get the serve instead. Matches
          are won by two points.
        </p>
        <p>
          {two
            ? "Keyboard: player 1 uses A and D to move and W to jump; player 2 uses the arrow keys."
            : "Keyboard: arrow keys or A and D to move; up, W or Space to jump."}{" "}
          Esc or P pauses. Gamepads work too (stick to move, A to jump). On a phone, buttons appear
          on screen; turn it sideways for a bigger court.
        </p>
      </section>
    </div>
  );
}

function OverlayCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xs rounded-xl border border-line bg-bg p-5 text-center text-fg shadow-xl"
      >
        <h2 className="mb-4 text-2xl font-extrabold tracking-tight">{title}</h2>
        <div className="flex flex-col gap-2.5">{children}</div>
      </div>
    </div>
  );
}

function MatchScreen({ setup, onQuit }: { setup: Setup; onQuit: () => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [round, setRound] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [over, setOver] = useState<{ title: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [muted, setMuted] = useState(() => load(MUTED_KEY) === "1");
  const mutedRef = useRef(muted);
  const coarse = useCoarsePointer();
  const [touched, setTouched] = useState(false);
  const touch = coarse || touched;
  const roles = controllers(setup);
  const people = hasPlayerTwo(setup) ? 2 : 1;
  const [controls] = useState(() => new Controls(people));

  useEffect(() => {
    pausedRef.current = paused || over !== null;
    mutedRef.current = muted;
  }, [paused, over, muted]);

  // Phones and tablets get on-screen buttons; so does anyone who touches the screen.
  useEffect(() => {
    const onTouch = () => setTouched(true);
    window.addEventListener("touchstart", onTouch, { once: true, passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, []);

  // The page behind the full-screen court shouldn't scroll. On iPhones, holding a button must not
  // start a text selection (with its copy menu) anywhere on the page, which CSS alone doesn't stop:
  // touches on the court and the buttons cancel the browser's own touch handling. Pointer events,
  // which the buttons use, still arrive.
  useEffect(() => {
    const root = document.documentElement;
    const locked = {
      overflow: "hidden",
      "user-select": "none",
      "-webkit-user-select": "none",
      "-webkit-touch-callout": "none",
    };
    const previous = Object.keys(locked).map((name) => [name, root.style.getPropertyValue(name)]);
    for (const [name, value] of Object.entries(locked)) root.style.setProperty(name, value);
    window.getSelection()?.removeAllRanges();

    const element = overlay.current!;
    const cancel = (event: Event) => event.preventDefault();
    const cancelGameTouch = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-game-touch]")) {
        event.preventDefault();
      }
    };
    document.addEventListener("selectstart", cancel);
    element.addEventListener("contextmenu", cancel);
    element.addEventListener("touchstart", cancelGameTouch, { passive: false });
    element.addEventListener("touchmove", cancelGameTouch, { passive: false });
    return () => {
      for (const [name, value] of previous) root.style.setProperty(name!, value!);
      document.removeEventListener("selectstart", cancel);
      element.removeEventListener("contextmenu", cancel);
      element.removeEventListener("touchstart", cancelGameTouch);
      element.removeEventListener("touchmove", cancelGameTouch);
    };
  }, []);

  // The match itself: a fixed-step simulation drawn on every animation frame.
  useEffect(() => {
    const element = canvas.current!;
    const area = stage.current!;
    const ctx = element.getContext("2d")!;
    const characters = charactersFor(setup);
    const names = sideNames(setup, characters);
    const match: Match = createMatch({
      characters,
      target: setup.target,
      court: setup.court,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    const cpus = roles.map((role, index) =>
      role === "cpu" ? new CpuPlayer(index, setup.level, index * 31 + 7) : null,
    );
    const tags = roles.map((role) =>
      role === "cpu" ? "CPU" : people === 1 ? "You" : role === "p1" ? "P1" : "P2",
    );
    let scale = 1;

    function resize() {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.min(area.clientWidth, (area.clientHeight * COURT_W) / COURT_H);
      element.style.width = `${Math.floor(width)}px`;
      element.style.height = `${Math.floor((width * COURT_H) / COURT_W)}px`;
      element.width = Math.round(width * ratio);
      element.height = Math.round(((width * COURT_H) / COURT_W) * ratio);
      scale = element.width / COURT_W;
      drawMatch(ctx, match, scale, tags, names);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(area);

    function inputs(): Input[] {
      return roles.map((role, index) =>
        role === "cpu" ? cpus[index]!.input(match) : controls.read(role === "p1" ? 0 : 1),
      );
    }

    let frame = 0;
    let last = performance.now();
    let pending = 0;
    function tick(now: number) {
      const elapsed = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (controls.startPressed()) setPaused((value) => !value);
      if (!pausedRef.current) {
        pending += elapsed;
        while (pending >= STEP) {
          pending -= STEP;
          for (const event of step(match, inputs())) {
            if (!mutedRef.current) playEvent(event);
            if (event.type === "rally-over") {
              const banner = rallyBanner(match, names) ?? "";
              setAnnouncement(`${banner} ${match.score[0]} to ${match.score[1]}.`);
            }
            if (event.type === "win") {
              const [a, b] = match.score;
              setOver({
                title: `${names[event.winner]} ${names[event.winner].endsWith("team") ? "win" : "wins"} ${Math.max(a, b)}–${Math.min(a, b)}`,
              });
            }
          }
        }
      } else pending = 0;
      drawMatch(ctx, match, scale, tags, names);
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);

    function onKeyDown(event: KeyboardEvent) {
      if (event.code === "Escape" || event.code === "KeyP") {
        setPaused((value) => !value);
        return;
      }
      if (!GAME_KEYS.has(event.code)) return;
      event.preventDefault();
      controls.keyDown(event.code);
    }
    const onKeyUp = (event: KeyboardEvent) => controls.keyUp(event.code);
    const onBlur = () => controls.release();
    const onHidden = () => {
      if (document.hidden) {
        controls.release();
        setPaused(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      controls.release();
    };
    // A new round (rematch) starts a new match; the setup can't change while playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  const touchControls = (edge: "left" | "right") => (
    <TouchControls
      people={people}
      edge={edge}
      onChange={(person, change) => controls.setTouch(person, change)}
    />
  );

  function rematch() {
    setOver(null);
    setPaused(false);
    setAnnouncement("");
    setRound((value) => value + 1);
  }

  function toggleMute() {
    unlockAudio();
    setMuted((value) => {
      save(MUTED_KEY, value ? "0" : "1");
      return !value;
    });
  }

  return (
    <div
      ref={overlay}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white select-none [-webkit-touch-callout:none]"
      data-testid="volley-match"
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          className={`${ghostButton} text-white/80 hover:bg-white/10 hover:text-white`}
          aria-label={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={toggleMute}
          className={`${ghostButton} text-white/80 hover:bg-white/10 hover:text-white`}
          aria-label={muted ? "Turn sound on" : "Turn sound off"}
        >
          {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={onQuit}
          className={`${ghostButton} text-white/80 hover:bg-white/10 hover:text-white`}
          aria-label="Quit match"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col landscape:flex-row">
        {touch && (
          <div className="hidden w-32 shrink-0 flex-col items-center justify-end pb-4 pl-[env(safe-area-inset-left)] landscape:flex">
            {touchControls("left")}
          </div>
        )}
        <div ref={stage} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Volleyball court"
            data-game-touch
            className="touch-none rounded-lg"
          />
        </div>
        {touch && (
          <div className="hidden w-32 shrink-0 flex-col items-center justify-end pr-[env(safe-area-inset-right)] pb-4 landscape:flex">
            {touchControls("right")}
          </div>
        )}
        {touch && (
          <div className="flex shrink-0 items-end justify-between px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] landscape:hidden">
            {touchControls("left")}
            {touchControls("right")}
          </div>
        )}
        {paused && !over && (
          <OverlayCard title="Paused">
            <button type="button" onClick={() => setPaused(false)} className={primaryButton}>
              <Play aria-hidden="true" />
              Resume
            </button>
            <button type="button" onClick={rematch} className={secondaryButton}>
              <RotateCcw aria-hidden="true" />
              Restart
            </button>
            <button type="button" onClick={onQuit} className={secondaryButton}>
              Quit
            </button>
          </OverlayCard>
        )}
        {over && (
          <OverlayCard title={over.title}>
            <button type="button" onClick={rematch} className={primaryButton}>
              <RotateCcw aria-hidden="true" />
              Rematch
            </button>
            <button type="button" onClick={onQuit} className={secondaryButton}>
              Change setup
            </button>
          </OverlayCard>
        )}
      </div>
      <p aria-live="polite" className="sr-only" data-testid="volley-announcer">
        {announcement}
      </p>
    </div>
  );
}
