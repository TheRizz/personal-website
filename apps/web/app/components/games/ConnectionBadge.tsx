import { Eye, RefreshCw } from "lucide-react";
import type { Ref } from "react";
import { MAX_RECONNECT_ATTEMPTS, type ConnectionStatus } from "~/lib/games/client-state";
import { primaryButton } from "./ui";

const DOT: Partial<Record<ConnectionStatus, string>> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  reconnecting: "bg-amber-500 animate-pulse",
  failed: "bg-red-500",
};

function label(connection: ConnectionStatus, attempt: number, lobbyFull: boolean): string {
  switch (connection) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting (${attempt} of ${MAX_RECONNECT_ATTEMPTS})…`;
    case "failed":
      return lobbyFull ? "Game full" : "Offline";
    case "replaced":
      return "Open in another tab";
    default:
      return "Disconnected";
  }
}

/** Small connection status pill. */
export function ConnectionBadge({
  connection,
  attempt,
  lobbyFull,
  ref,
}: {
  connection: ConnectionStatus;
  attempt: number;
  lobbyFull: boolean;
  /** Focus lands here after Reconnect or Watch here, whose buttons go away. */
  ref?: Ref<HTMLSpanElement>;
}) {
  return (
    <span
      ref={ref}
      tabIndex={-1}
      role="status"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[0.8rem] font-semibold text-muted"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[connection] ?? "bg-muted"}`} />
      {label(connection, attempt, lobbyFull)}
    </span>
  );
}

/** Explains a connection the client won't retry on its own, with a button to try again. */
export function ConnectionNotice({
  connection,
  lobbyFull,
  onReconnect,
}: {
  connection: ConnectionStatus;
  /** The server said the game is full, so this isn't a network problem. */
  lobbyFull: boolean;
  onReconnect: () => void;
}) {
  if (connection !== "failed" && connection !== "replaced") return null;
  const replaced = connection === "replaced";
  const [title, detail, action] = replaced
    ? [
        "This game is open in another tab.",
        "Your seat moved there. Keep playing in that tab, or watch from this one.",
        "Watch here",
      ]
    : lobbyFull
      ? [
          "This game is full.",
          "Both seats are taken and the most people are already watching. Try again in a little while.",
          "Try again",
        ]
      : ["Connection lost.", "Check your connection, then try again.", "Reconnect"];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
      <p className="flex-1 text-[0.95rem] leading-snug">
        <span className="font-semibold">{title}</span> <span className="text-muted">{detail}</span>
      </p>
      <button
        type="button"
        onClick={onReconnect}
        className={`${primaryButton} min-h-10 shrink-0 px-4 text-sm`}
      >
        {replaced ? <Eye aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        {action}
      </button>
    </div>
  );
}
