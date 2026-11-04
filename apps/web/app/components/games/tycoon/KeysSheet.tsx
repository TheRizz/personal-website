import { X } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { KEY_HELP } from "./keys";

// What `?` opens: the keyboard keys, in a small dialog like the settings sheet. Escape closes it
// (the browser does that for a modal dialog).

export function KeysSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="tycoon-keys-heading"
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 text-fg backdrop:bg-black/60 sm:m-auto sm:max-w-sm"
    >
      {open && (
        <div className="rounded-t-2xl border border-line bg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl">
          <div className="flex items-center justify-between">
            <h2 id="tycoon-keys-heading" className="text-lg font-bold">
              Keyboard keys
            </h2>
            <button
              onClick={onClose}
              aria-label="Close keyboard keys"
              className="-mr-2 rounded-lg p-2 text-muted hover:bg-surface hover:text-fg [&_svg]:size-5"
            >
              <X />
            </button>
          </div>
          <dl className="mt-3 divide-y divide-line text-[0.95rem]">
            {KEY_HELP.map(({ keys, range, does }) => (
              <div key={does} className="flex items-center justify-between gap-4 py-2.5">
                <dt className="flex shrink-0 items-center gap-1 text-muted">
                  {keys.map((key, i) => (
                    <Fragment key={key}>
                      {i > 0 && range && <span className="text-xs">to</span>}
                      <kbd className="inline-flex min-w-7 items-center justify-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[0.8rem] font-semibold text-fg tabular-nums">
                        {key}
                      </kbd>
                    </Fragment>
                  ))}
                </dt>
                <dd className="text-right text-muted">{does}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </dialog>
  );
}
