import { ArrowRight, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LOBBY_CODE_LENGTH, LOBBY_IDLE_TTL_MS } from "@site/game-core";
import { PageHeading } from "~/components/PageHeading";
import { checkName, NameField } from "~/components/games/NameField";
import { card, eyebrow, inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import { createLobby, CREATE_ERROR_TEXT } from "~/lib/games/api";
import { codeFromInput, lobbyPath } from "~/lib/games/links";
import { saveName, useSavedName } from "~/lib/games/storage";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.tictactoe";

const DESCRIPTION =
  "Play tic-tac-toe with a friend: start a game, share the link, play in real time.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Tic-tac-toe", description: DESCRIPTION, path: "/games/tictactoe" });

export default function TicTacToeLobby() {
  const navigate = useNavigate();
  const savedName = useSavedName();
  // null until the player edits the field, so the remembered name shows up after hydration.
  const [draftName, setDraftName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  // Aborted on unmount, so leaving the page mid-create doesn't pull the user into the lobby.
  const lifetime = useRef<AbortController | null>(null);
  const name = draftName ?? savedName ?? "";

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  /**
   * Validates and remembers the name; false if it isn't usable. Then the error is shown and the
   * field focused, which scrolls it into view and announces the error.
   */
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
    const result = await createLobby(fetch, signal);
    if (signal?.aborted) return;
    if (result.ok) {
      navigate(lobbyPath(result.code));
      return;
    }
    setCreating(false);
    setCreateError(CREATE_ERROR_TEXT[result.error]);
  }

  function join(event: FormEvent) {
    event.preventDefault();
    if (code.length !== LOBBY_CODE_LENGTH || !confirmName()) return;
    navigate(lobbyPath(code));
  }

  return (
    <>
      <PageHeading title="Tic-tac-toe">
        Start a game and send a friend the link, or join theirs with a code.
      </PageHeading>

      <div className="space-y-4">
        <div className={card}>
          <NameField
            value={name}
            onChange={(value) => {
              setDraftName(value);
              setNameError(null);
            }}
            error={nameError}
            inputRef={nameInput}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <section aria-labelledby="new-game-title" className={`${card} flex flex-col`}>
            <h2 id="new-game-title" className={eyebrow}>
              New game
            </h2>
            <p className="mt-2 mb-5 flex-1 text-[0.95rem] leading-relaxed text-muted">
              Get a game code and an invite link to share.
            </p>
            <button
              type="button"
              onClick={create}
              disabled={creating}
              aria-busy={creating}
              aria-describedby={createError ? "create-error" : undefined}
              className={`${primaryButton} w-full`}
            >
              <Plus aria-hidden="true" />
              {creating ? "Creating…" : "Create game"}
            </button>
            <p id="create-error" aria-live="polite" className="text-sm empty:hidden">
              {createError && (
                <span className="mt-3 block text-red-700 dark:text-red-400">{createError}</span>
              )}
            </p>
          </section>

          <form
            onSubmit={join}
            noValidate
            aria-labelledby="join-title"
            className={`${card} flex flex-col`}
          >
            <h2 id="join-title" className={eyebrow}>
              Join a game
            </h2>
            <label htmlFor={codeId} className="mt-2 mb-3 text-[0.95rem] leading-relaxed text-muted">
              Enter the {LOBBY_CODE_LENGTH}-character code from your friend.
            </label>
            <input
              id={codeId}
              name="code"
              type="text"
              value={code}
              onChange={(event) => setCode(codeFromInput(event.target.value))}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              inputMode="text"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="K7QXM2"
              className={`${inputClass} mb-3 text-center font-mono text-xl tracking-[0.3em] uppercase placeholder:tracking-[0.3em]`}
            />
            <button
              type="submit"
              disabled={code.length !== LOBBY_CODE_LENGTH}
              className={`${secondaryButton} w-full`}
            >
              Join game
              <ArrowRight aria-hidden="true" />
            </button>
          </form>
        </div>

        <p className="pt-2 text-sm leading-relaxed text-muted">
          Anyone with the link can join an empty seat or watch. Games close after{" "}
          {LOBBY_IDLE_TTL_MS / 60_000} minutes without activity.
        </p>
      </div>
    </>
  );
}
