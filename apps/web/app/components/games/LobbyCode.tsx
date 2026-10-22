import { Check, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { inviteUrl } from "~/lib/games/links";
import { eyebrow, secondaryButton } from "./ui";

/** Copies text, falling back to a hidden textarea where the async Clipboard API is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}

/** The lobby code in large type with a "Copy invite link" button. */
export function LobbyCode({ code, path }: { code: string; path?: (code: string) => string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    const ok = await copyText(inviteUrl(window.location.origin, code, path));
    setCopied(ok ? "copied" : "failed");
  }

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div>
        <p className={eyebrow}>Game code</p>
        <p className="mt-1 font-mono text-[2.6rem] leading-tight font-normal tracking-[0.18em] text-fg select-all sm:text-6xl">
          {code}
        </p>
      </div>
      <button type="button" onClick={copy} className={secondaryButton}>
        {copied === "copied" ? <Check /> : <Link2 />}
        {copied === "copied" ? "Copied" : "Copy invite link"}
      </button>
      <p className="sr-only" aria-live="polite">
        {copied === "copied" && "Invite link copied to the clipboard."}
        {copied === "failed" && "Couldn't copy the link. Copy it from the address bar instead."}
      </p>
      {copied === "failed" && (
        <p className="text-sm text-muted" aria-hidden="true">
          Couldn't copy the link. Copy it from the address bar instead.
        </p>
      )}
    </div>
  );
}
