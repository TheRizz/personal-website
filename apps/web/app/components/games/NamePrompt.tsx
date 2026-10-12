import { useState, type FormEvent } from "react";
import { checkName, NameField } from "./NameField";
import { card, primaryButton } from "./ui";

/** Asks an invited player for a display name before joining. */
export function NamePrompt({ code, onSubmit }: { code: string; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = checkName(value);
    if (result.ok) onSubmit(result.name);
    else setError(result.error);
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
          You've been invited to play tic-tac-toe
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
      />
      <button type="submit" className={`${primaryButton} w-full sm:w-auto`}>
        Join game
      </button>
    </form>
  );
}
