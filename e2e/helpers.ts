import { request as httpRequest } from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { serverMsgSchema, type ServerMsg } from "../packages/game-core/src/index";

/** Must match playwright.config.ts. */
export const BASE_URL = `http://localhost:${process.env.E2E_PORT ?? 4173}`;

let ipCounter = 0;

/**
 * A fake client IP for `CF-Connecting-IP`, unique per call and per run, so lobby creation never
 * shares a rate-limit window with another test (the local limiter persists across runs). It is an
 * IPv6 documentation address whose /64 prefix carries the uniqueness, because the API collapses
 * IPv6 addresses to their /64.
 */
export function uniqueIp(): string {
  const seconds = Math.floor(Date.now() / 1000);
  const n = (seconds * 4096 + (process.pid % 16) * 256 + (ipCounter++ % 256)) >>> 0;
  return `2001:db8:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}::1`;
}

export interface CreatedLobby {
  code: string;
  game: string;
  expiresAt: number;
}

/** POST /api/lobbies from `ip` (a fresh unique IP by default); expects 201. */
export async function createLobby(
  request: APIRequestContext,
  ip: string = uniqueIp(),
): Promise<CreatedLobby> {
  const response = await request.post("/api/lobbies", {
    headers: { "CF-Connecting-IP": ip },
    data: { game: "tictactoe" },
  });
  if (response.status() !== 201) {
    throw new Error(`createLobby: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as CreatedLobby;
}

export function wsUrl(code: string): string {
  return `${BASE_URL.replace(/^http/, "ws")}/api/lobbies/${code}/ws`;
}

/**
 * Status of a real WebSocket handshake for `path` (101 on success). Locally, `vite preview`
 * drops the connection instead of relaying a non-101 handshake response; that resolves to 0.
 */
export function handshakeStatus(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${BASE_URL}${path}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          "base64",
        ),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.message === "socket hang up") resolve(0);
      else reject(error);
    });
    req.end();
  });
}

export interface CloseInfo {
  code: number;
  reason: string;
}

/** A frame received from the server: a validated protocol message, or a raw text frame. */
type Received = { kind: "msg"; msg: ServerMsg } | { kind: "text"; text: string };

/**
 * A Node WebSocket client with an awaitable message queue. Every JSON frame must pass
 * serverMsgSchema; anything else (other than plain text like "pong") fails the waiting test.
 */
export class LobbyClient {
  private readonly queue: Received[] = [];
  private readonly problems: string[] = [];
  private wake: (() => void) | null = null;
  /** Resolves when the socket closes. */
  readonly closed: Promise<CloseInfo>;
  closeInfo: CloseInfo | null = null;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        this.closeInfo = { code: event.code, reason: event.reason };
        resolve(this.closeInfo);
        this.wake?.();
      });
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.problems.push("binary frame from server");
      } else {
        this.queue.push(LobbyClient.parse(event.data, this.problems));
      }
      this.wake?.();
    });
  }

  private static parse(text: string, problems: string[]): Received {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "text", text };
    }
    const parsed = serverMsgSchema.safeParse(data);
    if (!parsed.success) problems.push(`invalid server message: ${text}`);
    return parsed.success ? { kind: "msg", msg: parsed.data } : { kind: "text", text };
  }

  /** Opens a socket to the lobby; rejects if the handshake fails. */
  static connect(code: string): Promise<LobbyClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(code));
      const client = new LobbyClient(ws);
      ws.addEventListener("open", () => resolve(client), { once: true });
      ws.addEventListener("error", () => reject(new Error(`WebSocket to ${code} failed`)), {
        once: true,
      });
    });
  }

  /** Connects and joins; resolves with the client, its `joined` message and first state. */
  static async join(code: string, name: string, token?: string) {
    const client = await LobbyClient.connect(code);
    client.send({ t: "join", name, ...(token ? { token } : {}) });
    const joined = await client.next("joined");
    const state = await client.next("state");
    return { client, joined, state };
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /**
   * Waits for the next received frame that matches `predicate`, discarding earlier frames that
   * don't. Rejects on timeout, on close (if nothing matched) and on any invalid server message.
   */
  async nextFrame<T extends Received>(
    predicate: (frame: Received) => frame is T,
    timeout = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.problems.length > 0) throw new Error(this.problems.join("\n"));
      while (this.queue.length > 0) {
        const frame = this.queue.shift()!;
        if (predicate(frame)) return frame;
      }
      if (this.closeInfo) {
        throw new Error(`Socket closed (${this.closeInfo.code}) before a matching frame`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** The next server message of type `t` (optionally also matching `predicate`). */
  async next<K extends ServerMsg["t"]>(
    t: K,
    predicate: (msg: Extract<ServerMsg, { t: K }>) => boolean = () => true,
    timeout?: number,
  ): Promise<Extract<ServerMsg, { t: K }>> {
    const frame = await this.nextFrame(
      (f): f is { kind: "msg"; msg: Extract<ServerMsg, { t: K }> } =>
        f.kind === "msg" && f.msg.t === t && predicate(f.msg as Extract<ServerMsg, { t: K }>),
      timeout,
    );
    return frame.msg;
  }

  /** The next raw (non-JSON) text frame, e.g. "pong". */
  async nextText(timeout?: number): Promise<string> {
    const frame = await this.nextFrame(
      (f): f is { kind: "text"; text: string } => f.kind === "text",
      timeout,
    );
    return frame.text;
  }

  /** Resolves with the close info, or rejects if the socket stays open past `timeout`. */
  async waitForClose(timeout = 5_000): Promise<CloseInfo> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Socket did not close")), timeout);
    });
    try {
      return await Promise.race([this.closed, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Throws if any invalid server message arrived. */
  assertNoProblems(): void {
    if (this.problems.length > 0) throw new Error(this.problems.join("\n"));
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000);
    }
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
