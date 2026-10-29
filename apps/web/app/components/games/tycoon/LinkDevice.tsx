import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { TycoonApiError, normalisePairingCode, type TycoonController } from "@site/tycoon-core";
import { inputClass, secondaryButton } from "~/components/games/ui";
import { tycoonClient } from "~/lib/games/tycoon/api";

// Linking devices (docs/04-pipeline-tycoon.md §3): show a code the CLI (or another browser) can
// claim, or claim a code another device shows.

export const CLI_COMMAND = "npx @rymart/pipeline-tycoon";

const failureMessage = (error: unknown) => {
  if (error instanceof TycoonApiError) {
    if (error.failure.kind === "invalid_code") return "That code is wrong or has expired.";
    if (error.failure.kind === "rate_limited") return "Too many attempts. Try again in a minute.";
  }
  return "Couldn't reach the server. Try again.";
};

function useCountdown(until: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, until - now);
}

/** A one-time link code from the server and how long it has left. */
export function usePairingCode() {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(code?.until ?? null);
  const expired = code !== null && left === 0;

  /** Resolves to the new code, or null (with `error` set) when the server couldn't make one. */
  async function showCode(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      const created = await tycoonClient.createPairingCode();
      setCode({ code: created.code, until: Date.now() + created.expiresInMs });
      return created.code;
    } catch (e) {
      setError(failureMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000)
    .toString()
    .padStart(2, "0");
  return {
    code: expired ? null : (code?.code ?? null),
    expired,
    busy,
    error,
    showCode,
    left: `${minutes}:${seconds}`,
  };
}

export function LinkDevice({ controller }: { controller: TycoonController }) {
  const { code, expired, busy, error, showCode, left } = usePairingCode();
  const [copied, setCopied] = useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard blocked; the command is on screen to type.
    }
  }

  const command = code ? `${CLI_COMMAND} link ${code}` : "";

  return (
    <section className="mt-5 rounded-lg border border-line p-3" aria-labelledby="link-heading">
      <h3 id="link-heading" className="text-sm font-semibold">
        Play in your terminal
      </h3>
      <p className="mt-1 text-[0.8rem] leading-snug text-muted">
        The same game, the same save, as a terminal schematic. Show a code, then run the command on
        any computer with Node 20+.
      </p>
      {code ? (
        <div className="mt-3">
          <p
            className="font-mono text-2xl font-bold tracking-[0.3em] text-accent"
            aria-label={`Code ${code.split("").join(" ")}`}
          >
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5">
            <code className="min-w-0 flex-1 font-mono text-[0.75rem] break-all text-fg">
              {command}
            </code>
            <button
              onClick={() => void copy(command)}
              aria-label="Copy command"
              className="rounded p-1 text-muted hover:text-fg [&_svg]:size-4"
            >
              {copied ? <Check /> : <Copy />}
            </button>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">Works once, for {left}</p>
        </div>
      ) : (
        <button
          className={`${secondaryButton} mt-3`}
          disabled={busy}
          onClick={() => void showCode()}
        >
          {expired ? "Code expired — get a new one" : "Show a link code"}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[0.8rem] text-warn">
          {error}
        </p>
      )}
      <JoinWithCode controller={controller} />
    </section>
  );
}

/** Claim a code shown by the CLI (`pipeline-tycoon code`) or another browser. */
function JoinWithCode({ controller }: { controller: TycoonController }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = normalisePairingCode(value).length === 6;

  async function join() {
    setBusy(true);
    setError(null);
    try {
      // Whatever this browser had is saved first; it stays on the server, just unlinked from here.
      await controller.save();
      await tycoonClient.claimPairingCode(value);
      await controller.start();
      setOpen(false);
      setValue("");
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!open) {
    return (
      <button
        className="mt-3 text-[0.8rem] text-muted underline decoration-underline underline-offset-4 hover:text-fg"
        onClick={() => setOpen(true)}
      >
        Have a code from another device?
      </button>
    );
  }
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) setConfirming(true);
      }}
    >
      <label htmlFor="pair-code" className="text-[0.8rem] text-muted">
        Code
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="pair-code"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirming(false);
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={9}
          placeholder="ABC 234"
          className={`${inputClass} py-2 font-mono tracking-widest uppercase`}
        />
        <button type="submit" className={secondaryButton} disabled={!valid || busy}>
          Join
        </button>
      </div>
      {confirming && (
        <div role="alert" className="mt-2 rounded-md border border-warn/50 p-2 text-[0.8rem]">
          <p>
            This browser will switch to the other device&apos;s game. Your progress here stays on
            the server but can&apos;t be reached from this browser again unless you&apos;ve linked
            it elsewhere.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-fg px-3 py-1 font-semibold text-bg disabled:opacity-50"
              disabled={busy}
              onClick={() => void join()}
            >
              Switch
            </button>
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[0.8rem] text-warn">
          {error}
        </p>
      )}
    </form>
  );
}
