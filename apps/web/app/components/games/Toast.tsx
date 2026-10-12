import { X } from "lucide-react";
import { useEffect, useState } from "react";

const SHOW_MS = 5000;

/**
 * A transient message at the bottom of the screen inside a polite live region. A new `id` shows
 * the message again even when the text is unchanged.
 */
export function Toast({ message }: { message: { id: number; text: string } | null }) {
  const [dismissed, setDismissed] = useState<number | null>(null);
  const visible = message !== null && message.id !== dismissed;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setDismissed(message.id), SHOW_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {visible && (
        <div className="pointer-events-auto flex max-w-[min(32rem,100%)] items-start gap-3 rounded-xl border border-line bg-bg py-3 pr-2 pl-4 text-[0.95rem] text-fg shadow-xl shadow-black/20 transition duration-300 ease-spring starting:translate-y-3 starting:opacity-0">
          <p className="flex-1 py-0.5 leading-snug">{message.text}</p>
          <button
            type="button"
            onClick={() => setDismissed(message.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-surface-hover hover:text-fg [&_svg]:size-4"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
