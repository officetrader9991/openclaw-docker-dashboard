import crypto from "crypto";
import { getInternalUrl } from "./zeaburService";

// Dynamic import to avoid Next.js build-time static analysis issues with native ws module
let _WebSocket: typeof import("ws").WebSocket | null = null;
async function getWebSocket() {
  if (!_WebSocket) {
    const mod = await import("ws");
    _WebSocket = mod.WebSocket ?? (mod.default as unknown as typeof import("ws")).WebSocket;
  }
  return _WebSocket;
}

// --- Types ---

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  ws: InstanceType<typeof import("ws").WebSocket>;
  ready: boolean;
  lastUsed: number;
  pending: Map<string, PendingRequest>;
  connectPromise?: Promise<void>;
}

// --- Pool state ---

const pool = new Map<string, PoolEntry>();
const MAX_POOL_SIZE = 50;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
let sweepStarted = false;

function poolKey(serviceId: string, port: number): string {
  return `${serviceId}:${port}`;
}

function evictLRU() {
  if (pool.size < MAX_POOL_SIZE) return;
  let oldest: { key: string; ts: number } | null = null;
  for (const [key, entry] of pool) {
    if (!oldest || entry.lastUsed < oldest.ts) {
      oldest = { key, ts: entry.lastUsed };
    }
  }
  if (oldest) {
    const entry = pool.get(oldest.key);
    entry?.ws.close();
    pool.delete(oldest.key);
  }
}

function ensureIdleSweep() {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
        entry.ws.close();
        pool.delete(key);
      }
    }
  }, 60_000).unref();
}

async function connectWs(
  serviceId: string,
  port: number,
  token: string
): Promise<PoolEntry> {
  const key = poolKey(serviceId, port);
  const existing = pool.get(key);
  if (existing?.ready) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing?.connectPromise) {
    return existing.connectPromise.then(() => pool.get(key)!);
  }

  evictLRU();
  ensureIdleSweep();

  const WS = await getWebSocket();
  const url = `${getInternalUrl(serviceId, port).replace("http", "ws")}/__openclaw__/ws`;
  const ws = new WS(url);
  const entry: PoolEntry = {
    ws,
    ready: false,
    lastUsed: Date.now(),
    pending: new Map(),
  };

  entry.connectPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      pool.delete(key);
      reject(new Error("WS connect timeout"));
    }, 15_000);

    ws.on("message", (raw) => {
      let msg: WsMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Step 1: handle challenge
      if (msg.type === "event" && (msg as { event?: string }).event === "connect.challenge") {
        const connectId = crypto.randomUUID();
        ws.send(JSON.stringify({
          type: "request",
          method: "connect",
          id: connectId,
          params: {
            client: { id: "fleet-dashboard", displayName: "Fleet Dashboard", mode: "webchat", version: "1.0.0" },
            auth: { token },
            minProtocol: 1,
            maxProtocol: 1,
          },
        }));
        return;
      }

      // Step 2: handle connect response
      if (msg.type === "res" && !entry.ready) {
        clearTimeout(timeout);
        entry.ready = true;
        resolve();
        return;
      }

      // Step 3: route responses to pending requests
      if (msg.type === "res") {
        const id = msg.id as string;
        const pending = entry.pending.get(id);
        if (pending) {
          entry.pending.delete(id);
          clearTimeout(pending.timer);
          if ((msg as { ok?: boolean }).ok) {
            pending.resolve((msg as { result?: unknown }).result ?? msg);
          } else {
            pending.reject(new Error((msg as { error?: string }).error ?? "WS request failed"));
          }
        }
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      pool.delete(key);
      for (const p of entry.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("WS connection error"));
      }
      reject(new Error("WS connection error"));
    });

    ws.on("close", () => {
      pool.delete(key);
      for (const p of entry.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("WS connection closed"));
      }
    });
  });

  pool.set(key, entry);
  return entry.connectPromise.then(() => entry);
}

export async function sendRequest<T = unknown>(
  serviceId: string,
  port: number,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let lastError: Error | null = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const entry = await connectWs(serviceId, port, token);
      const id = crypto.randomUUID();

      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pending.delete(id);
          reject(new Error(`WS request timeout: ${method}`));
        }, timeoutMs);

        entry.pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });

        entry.ws.send(JSON.stringify({ type: "request", method, id, params }));
        entry.lastUsed = Date.now();
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Drop stale connection so next attempt reconnects
      const key = poolKey(serviceId, port);
      const stale = pool.get(key);
      if (stale) {
        stale.ws.close();
        pool.delete(key);
      }
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw lastError ?? new Error("WS request failed");
}

export function closeAll() {
  for (const [key, entry] of pool) {
    entry.ws.close();
    pool.delete(key);
  }
}

export function closeConnection(serviceId: string, port: number) {
  const key = poolKey(serviceId, port);
  const entry = pool.get(key);
  if (entry) {
    entry.ws.close();
    pool.delete(key);
  }
}
