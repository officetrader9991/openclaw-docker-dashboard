import { exec as execCb } from "child_process";
import { promisify } from "util";
import path from "path";
import type { MessageResult, MessagePayload } from "./types";
import { isZeabur } from "./fleetMode";
import { getAgentMeta } from "./agentDiscovery";
import * as zeabur from "./zeaburService";
import { sendRequest } from "./wsGateway";

const execAsync = promisify(execCb);
const FLEET_ROOT = path.resolve(process.cwd(), "..");

const ENV = {
  ...process.env,
  PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
  HOME: process.env.REAL_HOME || `/Users/${process.env.USER || "ozaru"}`,
  DOCKER_CLI_HINTS: "false",
};

function run(cmd: string, timeout = 30000) {
  return execAsync(cmd, { timeout, env: ENV });
}

function containerName(agentId: string): string {
  return `openclaw-${agentId}`;
}

export interface SessionInfo {
  key: string;
  sessionId: string;
  updatedAt: number;
  model?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

// ===================== Docker mode =====================

async function dockerSendMessage(
  port: number, token: string, sessionId: string, message: string
): Promise<MessageResult> {
  const name = `openclaw-agent-${String(port - 18700).padStart(2, "0")}`;
  const escaped = message.replace(/'/g, "'\\''");
  const { stdout } = await run(
    `docker exec ${name} openclaw agent --session-id "${sessionId}" --message '${escaped}' --json`,
    120000
  );
  const result = JSON.parse(stdout);
  const rawPayloads: { text?: string }[] = result.result?.payloads ?? [];
  const meta = result.result?.meta?.agentMeta;
  const payloads: MessagePayload[] = rawPayloads
    .filter((p) => p.text?.trim())
    .map((p, i, arr) => ({ text: p.text!.trim(), isFinal: i === arr.length - 1 }));
  if (payloads.length === 0) payloads.push({ text: "(no response)", isFinal: true });
  return {
    payloads,
    durationMs: result.result?.meta?.durationMs ?? 0,
    model: meta ? `${meta.provider}/${meta.model}` : "unknown",
  };
}

async function dockerSetModelLive(agentId: string, modelFullId: string): Promise<string> {
  const name = containerName(agentId);
  const escaped = modelFullId.replace(/"/g, '\\"');
  await run(`docker exec ${name} openclaw config set agents.defaults.model.primary "${escaped}"`, 10000);
  await run(`cd "${FLEET_ROOT}" && docker compose restart ${agentId} 2>&1`);
  return modelFullId;
}

async function dockerGetLogs(agentId: string, tail: number): Promise<string> {
  try {
    const { stdout } = await run(`docker logs ${containerName(agentId)} --tail ${tail} 2>&1`, 10000);
    return stdout;
  } catch {
    return "(container not running or not found)";
  }
}

async function dockerGetSessionList(agentId: string): Promise<SessionInfo[]> {
  const name = containerName(agentId);
  const sessionsDir = "/home/openclaw/.openclaw/agents/main/sessions";
  let sessions: SessionInfo[] = [];
  const knownSessionIds = new Set<string>();

  try {
    const { stdout } = await run(`docker exec ${name} openclaw sessions --json`, 10000);
    const data = JSON.parse(stdout);
    sessions = (data.sessions ?? []).map(
      (s: { key?: string; sessionId?: string; updatedAt?: number; model?: string }) => ({
        key: s.key ?? "", sessionId: s.sessionId ?? "", updatedAt: s.updatedAt ?? 0, model: s.model,
      })
    );
    for (const s of sessions) knownSessionIds.add(s.sessionId);
  } catch { /* fall through */ }

  try {
    const { stdout: lsOut } = await run(`docker exec ${name} ls -1 --time=ctime "${sessionsDir}"`, 10000);
    for (const filename of lsOut.split("\n")) {
      if (!filename.endsWith(".jsonl")) continue;
      const sid = filename.replace(/\.jsonl$/, "");
      if (knownSessionIds.has(sid) || sid === "sessions") continue;
      let updatedAt = 0;
      try {
        const { stdout: stat } = await run(`docker exec ${name} stat -c %Y "${sessionsDir}/${filename}"`, 5000);
        updatedAt = parseInt(stat.trim(), 10) * 1000;
      } catch { /* use 0 */ }
      sessions.push({ key: `agent:main:${sid}`, sessionId: sid, updatedAt });
    }
  } catch { /* ignore scan errors */ }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

async function dockerGetSessionHistory(agentId: string, sessionId: string): Promise<HistoryMessage[]> {
  const name = containerName(agentId);
  const sessionsDir = "/home/openclaw/.openclaw/agents/main/sessions";
  const escaped = sessionId.replace(/"/g, "");
  try {
    const { stdout } = await run(`docker exec ${name} cat "${sessionsDir}/${escaped}.jsonl"`, 10000);
    const messages: HistoryMessage[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const role = entry.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = entry.message?.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content.filter((c: { type?: string }) => c.type === "text")
            .map((c: { text?: string }) => c.text ?? "").join("\n");
        }
        text = text.replace(/^\[.*?\]\s*/, "").trim();
        if (!text) continue;
        messages.push({ role, text });
      } catch { /* skip malformed */ }
    }
    return messages;
  } catch { return []; }
}

async function dockerControlContainer(agentId: string, action: "start" | "stop" | "restart"): Promise<string> {
  try {
    const { stdout } = await run(`cd "${FLEET_ROOT}" && docker compose ${action} ${agentId} 2>&1`);
    return stdout.trim() || `${action} completed`;
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ===================== Zeabur mode =====================

function requireMeta(agentId: string) {
  const meta = getAgentMeta(agentId);
  if (!meta) throw new Error(`No cached metadata for agent: ${agentId}. Discover it first.`);
  return meta;
}

async function zeaburSendMessage(
  port: number, token: string, sessionId: string, message: string
): Promise<MessageResult> {
  // Find serviceId from agentMap by matching token+port
  const { getAgentMeta } = await import("./agentDiscovery");
  // agentMap is module-level — scan all known agents
  // We don't have direct access to the map, but getAgentMeta takes agentId.
  // Instead, fall back to scanning services by resolved token.
  let serviceId: string | null = null;
  const services = await zeabur.listAgentServices();
  for (const svc of services) {
    try {
      const vars = await zeabur.getServiceVariables(svc.serviceId);
      const raw = vars.OPENCLAW_GATEWAY_TOKEN ?? "";
      const match = raw.match(/^\$\{(.+)\}$/);
      const resolvedToken = match ? (vars[match[1]] ?? vars.PASSWORD ?? "") : (raw || vars.PASSWORD || "");
      if (resolvedToken === token) { serviceId = svc.serviceId; break; }
    } catch { /* skip */ }
  }
  if (!serviceId) throw new Error("Could not find service matching gateway token");

  const result = await sendRequest<{
    payloads?: { text?: string }[];
    meta?: { durationMs?: number; agentMeta?: { provider?: string; model?: string } };
  }>(serviceId, port, token, "chat.send", { sessionId, message }, 120000);

  const rawPayloads = result.payloads ?? [];
  const meta = result.meta?.agentMeta;
  const payloads: MessagePayload[] = rawPayloads
    .filter((p) => p.text?.trim())
    .map((p, i, arr) => ({ text: p.text!.trim(), isFinal: i === arr.length - 1 }));
  if (payloads.length === 0) payloads.push({ text: "(no response)", isFinal: true });

  return {
    payloads,
    durationMs: result.meta?.durationMs ?? 0,
    model: meta ? `${meta.provider}/${meta.model}` : "unknown",
  };
}

async function zeaburSetModelLive(agentId: string, modelFullId: string): Promise<string> {
  const meta = requireMeta(agentId);
  await sendRequest(meta.serviceId, meta.port, meta.token, "config.set", {
    path: "agents.defaults.model.primary", value: modelFullId,
  });
  await zeabur.controlService(meta.serviceId, "restart");
  return modelFullId;
}

async function zeaburGetLogs(agentId: string): Promise<string> {
  const meta = requireMeta(agentId);
  try {
    return await zeabur.getRuntimeLogs(meta.serviceId);
  } catch {
    return "(service not running or not found)";
  }
}

async function zeaburGetSessionList(agentId: string): Promise<SessionInfo[]> {
  const meta = requireMeta(agentId);
  try {
    const result = await sendRequest<{
      sessions?: { key?: string; sessionId?: string; updatedAt?: number; model?: string; defaults?: { model?: string } }[];
      defaults?: { model?: string };
    }>(meta.serviceId, meta.port, meta.token, "sessions.list");
    // sessions.list returns payload directly (not wrapped)
    const raw = (result as { sessions?: unknown[] }).sessions ?? [];
    const sessions: SessionInfo[] = (raw as { key?: string; sessionId?: string; updatedAt?: number; model?: string }[]).map((s) => ({
      key: s.key ?? "",
      sessionId: s.sessionId ?? "",
      updatedAt: s.updatedAt ?? 0,
      model: s.model,
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  } catch {
    return [];
  }
}

async function zeaburGetSessionHistory(agentId: string, sessionId: string): Promise<HistoryMessage[]> {
  const meta = requireMeta(agentId);

  // First get the sessionKey from sessions.list so we can use chat.history
  let sessionKey: string | undefined;
  try {
    const listResult = await sendRequest<{
      sessions?: { key?: string; sessionId?: string }[];
    }>(meta.serviceId, meta.port, meta.token, "sessions.list");
    sessionKey = listResult.sessions?.find((s) => s.sessionId === sessionId)?.key;
  } catch { /* fall through */ }

  try {
    const params = sessionKey ? { sessionKey } : { sessionKey: sessionId };
    const result = await sendRequest<{
      payload?: {
        messages?: { role?: string; content?: { type?: string; text?: string }[] | string }[];
      };
      messages?: { role?: string; text?: string; content?: string }[];
    }>(meta.serviceId, meta.port, meta.token, "chat.history", params);

    // Handle both payload-wrapped and flat response shapes
    const rawMessages = result.payload?.messages ?? (result as { messages?: unknown[] }).messages ?? [];
    const messages: HistoryMessage[] = [];
    for (const m of rawMessages as { role?: string; content?: unknown; text?: string }[]) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        text = (m.content as { type?: string; text?: string }[])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
      } else if (typeof m.text === "string") {
        text = m.text;
      }
      // Strip conversation metadata prefix
      text = text.replace(/^Conversation info[\s\S]*?```\s*\n/m, "").replace(/^\[.*?\]\s*/, "").trim();
      if (text) messages.push({ role: m.role as "user" | "assistant", text });
    }
    return messages;
  } catch {
    // Fallback to sessions.preview with keys array
    try {
      const keys = sessionKey ? [sessionKey] : [sessionId];
      const result = await sendRequest<{
        payload?: { previews?: { messages?: { role?: string; text?: string }[] }[] };
        previews?: { messages?: { role?: string; text?: string }[] }[];
      }>(meta.serviceId, meta.port, meta.token, "sessions.preview", { keys });
      const previews = result.payload?.previews ?? (result as { previews?: unknown[] }).previews ?? [];
      const msgs = (previews as { messages?: { role?: string; text?: string }[] }[])[0]?.messages ?? [];
      return msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.text ?? "" }))
        .filter((m) => m.text.trim());
    } catch {
      return [];
    }
  }
}

async function zeaburControlContainer(
  agentId: string, action: "start" | "stop" | "restart"
): Promise<string> {
  const meta = requireMeta(agentId);
  try {
    if (action === "stop") {
      await zeabur.controlService(meta.serviceId, "suspend");
    } else if (action === "start") {
      await zeabur.controlService(meta.serviceId, "resume");
    } else {
      await zeabur.controlService(meta.serviceId, "restart");
    }
    return `${action} completed`;
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ===================== Public API =====================

export async function sendAgentMessage(
  port: number, token: string, sessionId: string, message: string
): Promise<MessageResult> {
  return isZeabur()
    ? zeaburSendMessage(port, token, sessionId, message)
    : dockerSendMessage(port, token, sessionId, message);
}

export async function setModelLive(agentId: string, modelFullId: string): Promise<string> {
  return isZeabur() ? zeaburSetModelLive(agentId, modelFullId) : dockerSetModelLive(agentId, modelFullId);
}

export async function getContainerLogs(agentId: string, tail = 50): Promise<string> {
  return isZeabur() ? zeaburGetLogs(agentId) : dockerGetLogs(agentId, tail);
}

export async function getSessionList(agentId: string): Promise<SessionInfo[]> {
  return isZeabur() ? zeaburGetSessionList(agentId) : dockerGetSessionList(agentId);
}

export async function getSessionHistory(agentId: string, sessionId: string): Promise<HistoryMessage[]> {
  return isZeabur() ? zeaburGetSessionHistory(agentId, sessionId) : dockerGetSessionHistory(agentId, sessionId);
}

export async function controlContainer(agentId: string, action: "start" | "stop" | "restart"): Promise<string> {
  return isZeabur() ? zeaburControlContainer(agentId, action) : dockerControlContainer(agentId, action);
}
