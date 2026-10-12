import { RefreshCw } from "lucide-react";
import { MAX_RECONNECT_ATTEMPTS, type ConnectionStatus } from "~/lib/games/client-state";
import { primaryButton } from "./ui";

const DOT: Partial<Record<ConnectionStatus, string>> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  reconnecting: "bg-amber-500 animate-pulse",
  failed: "bg-red-500",
};

function label(connection: ConnectionStatus, attempt: number): string {
  switch (connection) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting (${attempt} of ${MAX_RECONNECT_ATTEMPTS})…`;
    case "failed":
      return "Offline";
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
}: {
  connection: ConnectionStatus;
  attempt: number;
}) {
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[0.8rem] font-semibold text-muted"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[connection] ?? "bg-muted"}`} />
      {label(connection, attempt)}
    </span>
  );
}

/** Explains a connection the client won't retry on its own, with a button to try again. */
export function ConnectionNotice({
  connection,
  onReconnect,
}: {
  connection: ConnectionStatus;
  onReconnect: () => void;
}) {
  if (connection !== "failed" && connection !== "replaced") return null;
  const replaced = connection === "replaced";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
      <p className="flex-1 text-[0.95rem] leading-snug">
        <span className="font-semibold">
          {replaced ? "This game is open in another tab." : "Connection lost."}
        </span>{" "}
        <span className="text-muted">
          {replaced ? "Only one tab can hold your seat." : "Check your connection, then try again."}
        </span>
      </p>
      <button
        type="button"
        onClick={onReconnect}
        className={`${primaryButton} min-h-10 shrink-0 px-4 text-sm`}
      >
        <RefreshCw aria-hidden="true" />
        {replaced ? "Play here" : "Reconnect"}
      </button>
    </div>
  );
}
