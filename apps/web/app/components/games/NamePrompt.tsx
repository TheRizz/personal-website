import { useRef, useState, type FormEvent } from "react";
import { checkName, NameField } from "./NameField";
import { card, primaryButton } from "./ui";

/** Asks an invited player for a display name before joining. */
export function NamePrompt({
  code,
  game = "tic-tac-toe",
  onSubmit,
}: {
  code: string;
  game?: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = checkName(value);
    if (result.ok) {
      onSubmit(result.name);
    } else {
      setError(result.error);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className={`${card} space-y-6`}
      aria-labelledby="invite-title"
    >
      <div>
        <h2 id="invite-title" className="text-2xl leading-tight font-bold tracking-tight">
          You've been invited to play {game}
        </h2>
        <p className="mt-2 text-muted">
          Pick a name to join game <span className="font-mono text-fg">{code}</span>.
        </p>
      </div>
      <NameField
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        error={error}
        autoFocus
        inputRef={inputRef}
      />
      <button type="submit" className={`${primaryButton} w-full sm:w-auto`}>
        Join game
      </button>
    </form>
  );
}
