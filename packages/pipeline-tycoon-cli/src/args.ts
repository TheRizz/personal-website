// Command-line arguments. Small enough not to need a library.

export const DEFAULT_SERVER = "https://ry-mart.com";

export type Command =
  | { kind: "play" }
  | { kind: "link"; code: string }
  | { kind: "code" }
  | { kind: "unlink" }
  | { kind: "help" }
  | { kind: "version" };

export interface Args {
  command: Command;
  server: string;
  color: boolean | null;
}

export class UsageError extends Error {}

export const USAGE = `Pipeline Tycoon — the idle data-pipeline game, in your terminal.

Usage
  pipeline-tycoon               play (starts a new game, or continues a linked one)
  pipeline-tycoon link <CODE>   play the game from your browser: get a code on
                                ry-mart.com/games/pipeline-tycoon → Stats
  pipeline-tycoon code          show a code to open this game in a browser
  pipeline-tycoon unlink        forget the game on this computer

Options
  --server <url>   server to play on (default ${DEFAULT_SERVER})
  --no-color       plain text
  -h, --help       this help
  -v, --version    the version`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  let server = env.PIPELINE_TYCOON_SERVER ?? DEFAULT_SERVER;
  let color: boolean | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { command: { kind: "help" }, server, color };
    if (arg === "-v" || arg === "--version") return { command: { kind: "version" }, server, color };
    if (arg === "--no-color") color = false;
    else if (arg === "--color") color = true;
    else if (arg === "--server" || arg.startsWith("--server=")) {
      const value = arg.includes("=") ? arg.slice("--server=".length) : argv[++i];
      if (!value) throw new UsageError("--server needs a URL.");
      server = value;
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  try {
    const url = new URL(server);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new UsageError("The server must use https (http is allowed for localhost).");
    }
    server = url.origin;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Not a URL: ${server}`);
  }

  const [name, ...rest] = positional;
  let command: Command;
  switch (name) {
    case undefined:
    case "play":
      command = { kind: "play" };
      break;
    case "link": {
      const code = rest.join("");
      if (!code) throw new UsageError("Usage: pipeline-tycoon link <CODE>");
      command = { kind: "link", code };
      rest.length = 0;
      break;
    }
    case "code":
      command = { kind: "code" };
      break;
    case "unlink":
      command = { kind: "unlink" };
      break;
    case "help":
      command = { kind: "help" };
      break;
    default:
      throw new UsageError(`Unknown command "${name}". Try --help.`);
  }
  if (rest.length > 0) throw new UsageError(`Unexpected "${rest.join(" ")}". Try --help.`);
  return { command, server, color };
}
