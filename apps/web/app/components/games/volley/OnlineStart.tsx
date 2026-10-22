import { ArrowRight, Globe } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LOBBY_CODE_LENGTH } from "@site/game-core";
import { checkName, NameField } from "~/components/games/NameField";
import { eyebrow, inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import { createVolleyRoom, CREATE_ERROR_TEXT } from "~/lib/games/api";
import { codeFromInput, volleyPath } from "~/lib/games/links";
import { saveName, useSavedName } from "~/lib/games/storage";
import type { Setup } from "~/lib/games/volley/setup";

/**
 * The end of the setup screen in online mode: your name, then start a room (with the court and
 * points chosen above) or join a friend's with their code.
 */
export function OnlineStart({ setup, ready }: { setup: Setup; ready: boolean }) {
  const navigate = useNavigate();
  const savedName = useSavedName();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const name = draftName ?? savedName ?? "";

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  function confirmName(): boolean {
    const result = checkName(name);
    if (!result.ok) {
      setNameError(result.error);
      nameInput.current?.focus();
      return false;
    }
    saveName(result.name);
    return true;
  }

  async function create() {
    setCreateError(null);
    if (!confirmName()) return;
    setCreating(true);
    const signal = lifetime.current?.signal;
    const result = await createVolleyRoom(
      { court: setup.court, target: setup.target },
      fetch,
      signal,
    );
    if (signal?.aborted) return;
    if (result.ok) {
      navigate(volleyPath(result.code));
      return;
    }
    setCreating(false);
    setCreateError(CREATE_ERROR_TEXT[result.error]);
  }

  function join(event: FormEvent) {
    event.preventDefault();
    if (code.length !== LOBBY_CODE_LENGTH || !confirmName()) return;
    navigate(volleyPath(code));
  }

  return (
    <div className="space-y-6">
      <NameField
        value={name}
        onChange={(value) => {
          setDraftName(value);
          setNameError(null);
        }}
        error={nameError}
        inputRef={nameInput}
      />
      <div>
        <button
          type="button"
          onClick={create}
          disabled={!ready || creating}
          aria-busy={creating}
          aria-describedby={createError ? "create-error" : undefined}
          className={`${primaryButton} w-full`}
        >
          <Globe aria-hidden="true" />
          {creating ? "Creating…" : "Create online game"}
        </button>
        <p id="create-error" aria-live="polite" className="text-sm empty:hidden">
          {createError && (
            <span className="mt-3 block text-red-700 dark:text-red-400">{createError}</span>
          )}
        </p>
      </div>
      <form onSubmit={join} noValidate aria-labelledby="join-title">
        <h3 id="join-title" className={`${eyebrow} mb-2`}>
          Or join a friend's game
        </h3>
        <label htmlFor={codeId} className="sr-only">
          Game code
        </label>
        <div className="flex gap-2">
          <input
            id={codeId}
            name="code"
            type="text"
            value={code}
            onChange={(event) => setCode(codeFromInput(event.target.value))}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="K7QXM2"
            className={`${inputClass} min-w-0 text-center font-mono text-lg tracking-[0.25em] uppercase placeholder:tracking-[0.25em]`}
          />
          <button
            type="submit"
            disabled={!ready || code.length !== LOBBY_CODE_LENGTH}
            className={`${secondaryButton} shrink-0`}
          >
            Join
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
