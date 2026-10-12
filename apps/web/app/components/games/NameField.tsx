import { useId, type Ref } from "react";
import { displayNameSchema, MAX_NAME_LENGTH } from "@site/game-core";
import { eyebrow, inputClass } from "./ui";

/** Validates a display name; returns the trimmed name or the first problem. */
export function checkName(
  value: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const parsed = displayNameSchema.safeParse(value);
  if (parsed.success) return { ok: true, name: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a name." };
}

/** Labelled display-name input with an announced error message. */
export function NameField({
  value,
  onChange,
  error,
  autoFocus = false,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  autoFocus?: boolean;
  /** Lets the form focus the field when the name is rejected. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`${eyebrow} mb-2 block`}>
        Your name
      </label>
      <input
        ref={inputRef}
        id={id}
        name="name"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="nickname"
        autoFocus={autoFocus}
        enterKeyHint="go"
        spellCheck={false}
        placeholder="What should we call you?"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        className={inputClass}
      />
      <p id={`${id}-hint`} className="mt-2 text-sm text-muted" aria-live="polite">
        {error ? (
          <span className="text-red-700 dark:text-red-400">{error}</span>
        ) : (
          "Shown to the other player."
        )}
      </p>
    </div>
  );
}
