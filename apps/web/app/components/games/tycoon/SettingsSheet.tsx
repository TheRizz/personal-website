import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatNumber, type Notation } from "@site/tycoon-core";
import { secondaryButton } from "~/components/games/ui";
import { CLI_COMMAND, usePairingCode } from "./LinkDevice";
import { updateSettings, useSettings } from "./settings";
import { unlockAudio } from "./sound";

// The gear's sheet: sound, number style, calmer scene and the save code (the Stats tab's link
// code, one tap away). A bottom sheet on phones, a small dialog on wider screens.

const NOTATION_LABELS: Record<Notation, string> = {
  short: "Short",
  long: "Long",
  scientific: "Scientific",
};
const EXAMPLE = 1.2e9;

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useSettings();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="tycoon-settings-heading"
      onClose={onClose}
      // A tap on the backdrop lands on the dialog itself, outside the panel.
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 text-fg backdrop:bg-black/60 sm:m-auto sm:max-w-sm"
    >
      {/* Nothing inside while closed, so the page has one link code and one "Code" field. */}
      {open && (
        <div className="rounded-t-2xl border border-line bg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl">
          <div className="flex items-center justify-between">
            <h2 id="tycoon-settings-heading" className="text-lg font-bold">
              Settings
            </h2>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="-mr-2 rounded-lg p-2 text-muted hover:bg-surface hover:text-fg [&_svg]:size-5"
            >
              <X />
            </button>
          </div>

          <div className="mt-3 divide-y divide-line">
            <Toggle
              label="Sound"
              hint="Blips for clicks, purchases and golden packets."
              on={settings.sound}
              onChange={(sound) => {
                if (sound) unlockAudio();
                updateSettings({ sound });
              }}
            />
            <fieldset className="py-3">
              <legend className="text-[0.95rem] font-semibold">Numbers</legend>
              <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-surface p-1">
                {(Object.keys(NOTATION_LABELS) as Notation[]).map((notation) => (
                  <label
                    key={notation}
                    className="flex cursor-pointer flex-col items-center rounded-lg px-1 py-1.5 text-center text-muted transition-colors has-checked:bg-bg has-checked:text-fg has-focus-visible:ring-2 has-focus-visible:ring-fg/30"
                  >
                    <input
                      type="radio"
                      name="tycoon-notation"
                      value={notation}
                      checked={settings.notation === notation}
                      onChange={() => updateSettings({ notation })}
                      className="sr-only"
                    />
                    <span className="text-sm font-semibold">{NOTATION_LABELS[notation]}</span>
                    <span className="text-[0.75rem] tabular-nums">
                      {formatNumber(EXAMPLE, notation)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Toggle
              label="Reduce motion"
              hint="The factory stops pulsing, spinning and bursting. Packets still flow."
              on={settings.reduceMotion}
              onChange={(reduceMotion) => updateSettings({ reduceMotion })}
            />
            <SaveCode />
          </div>
        </div>
      )}
    </dialog>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-[0.95rem] font-semibold">{label}</p>
        <p className="text-[0.8rem] leading-snug text-muted">{hint}</p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className="relative h-7 w-12 shrink-0 rounded-full bg-surface-hover transition-colors aria-checked:bg-accent"
      >
        <span
          aria-hidden="true"
          className={`absolute top-1 left-1 size-5 rounded-full bg-fg transition-transform ${on ? "translate-x-5" : ""}`}
        />
      </button>
    </div>
  );
}

/**
 * Copies a fresh link code. Safari only lets a page write to the clipboard during the tap, so
 * the code (still on its way from the server) goes in as a promise; the code is shown either way.
 */
function SaveCode() {
  const { code, expired, busy, error, showCode, left } = usePairingCode();
  const [copied, setCopied] = useState<boolean | null>(null);

  function copyCode() {
    setCopied(null);
    const coming = showCode();
    const text = coming.then((value) => {
      if (value === null) throw new Error("no code");
      return value;
    });
    let write: Promise<void>;
    try {
      write = navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
        }),
      ]);
    } catch {
      write = text.then((value) => navigator.clipboard.writeText(value));
    }
    write.then(
      () => setCopied(true),
      () => void coming.then((value) => value !== null && setCopied(false)),
    );
  }

  return (
    <section className="pt-3" aria-labelledby="save-code-heading">
      <h3 id="save-code-heading" className="text-[0.95rem] font-semibold">
        Save code
      </h3>
      <p className="text-[0.8rem] leading-snug text-muted">
        Carry this game to another browser, or to the terminal with{" "}
        <code className="font-mono text-[0.75rem]">{CLI_COMMAND} link</code>.
      </p>
      {code ? (
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <p
            className="font-mono text-2xl font-bold tracking-[0.3em] text-accent"
            aria-label={`Code ${code.split("").join(" ")}`}
            data-testid="save-code"
          >
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="text-right text-xs text-muted tabular-nums" role="status">
            {copied === true ? "Copied. " : copied === false ? "Copy blocked, type it in. " : ""}
            Works once, for {left}
          </p>
        </div>
      ) : (
        <button className={`${secondaryButton} mt-2 w-full`} disabled={busy} onClick={copyCode}>
          {expired ? "Code expired, copy a new one" : "Copy my save code"}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[0.8rem] text-warn">
          {error}
        </p>
      )}
    </section>
  );
}
