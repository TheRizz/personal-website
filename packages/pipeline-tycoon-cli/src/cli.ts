import { createInterface } from "node:readline/promises";
import { TycoonApiError, TycoonClient, normalisePairingCode } from "@site/tycoon-core";
import { play } from "./app";
import { DEFAULT_SERVER, USAGE, UsageError, parseArgs } from "./args";
import { configPath, fileStore } from "./config";
import { MIN_COLS, MIN_ROWS } from "./render";
import { detectColorMode } from "./screen";

declare const __CLI_VERSION__: string;
const VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "dev";

const WEB = "https://ry-mart.com/games/pipeline-tycoon";

function explain(error: unknown): string {
  if (error instanceof TycoonApiError) {
    switch (error.failure.kind) {
      case "invalid_code":
        return "That code is wrong or has expired. Get a new one from the web game (Stats tab).";
      case "rate_limited":
        return "Too many attempts from your network. Wait a minute and try again.";
      case "update_required":
        return "This version is out of date. Run: npx @rymart/pipeline-tycoon@latest";
      case "unauthorized":
        return "This computer's game isn't recognised any more. Run `pipeline-tycoon link <CODE>`.";
      case "network":
        return `Couldn't reach the server (${error.failure.detail}).`;
      default:
        return `The server said: ${error.failure.kind}.`;
    }
  }
  return String(error);
}

/** First run with no player: link to the web game, or start fresh here. */
async function firstRun(client: TycoonClient): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Welcome to Pipeline Tycoon.\n");
    console.log(`Already playing in a browser? Open ${WEB}, go to Stats →`);
    console.log("“Play in your terminal” → “Show a link code”, and type the code here.\n");
    const answer = await rl.question("Link code (or press Enter to start a new game): ");
    const code = normalisePairingCode(answer);
    if (code) {
      await client.claimPairingCode(code);
      console.log("Linked. Same game, now in your terminal.");
    }
  } finally {
    rl.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  if (args.command.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (args.command.kind === "version") {
    console.log(VERSION);
    return 0;
  }

  const path = configPath();
  const client = new TycoonClient({ baseUrl: args.server, kind: "cli", store: fileStore(path) });
  const serverLabel = args.server === DEFAULT_SERVER ? "ry-mart.com" : new URL(args.server).host;

  try {
    switch (args.command.kind) {
      case "unlink":
        await client.forgetDevice();
        console.log("Forgotten. Your game is still on the server for any other linked device.");
        return 0;
      case "code": {
        if (!client.hasPlayer()) {
          console.error("No game on this computer yet. Run `pipeline-tycoon` to start one.");
          return 1;
        }
        const { code, expiresInMs } = await client.createPairingCode();
        console.log(`\n  ${code.slice(0, 3)} ${code.slice(3)}\n`);
        console.log(`Open ${WEB}, Stats → “Have a code from another device?”, and type it.`);
        console.log(`It works once, for ${Math.round(expiresInMs / 60_000)} minutes.`);
        return 0;
      }
      case "link":
        await client.claimPairingCode(args.command.code);
        console.log("Linked.");
        break;
      case "play":
        break;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Pipeline Tycoon needs an interactive terminal.");
      return 1;
    }
    if ((process.stdout.columns ?? 0) < MIN_COLS || (process.stdout.rows ?? 0) < MIN_ROWS) {
      console.log(`Tip: it plays best at ${MIN_COLS}×${MIN_ROWS} or bigger.`);
    }
    if (!client.hasPlayer()) await firstRun(client);
    const colorMode = detectColorMode(process.env, true, args.color);
    return await play({ client, colorMode, serverLabel });
  } catch (error) {
    console.error(explain(error));
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    console.error(error);
    process.exit(1);
  },
);
