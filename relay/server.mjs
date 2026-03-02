import express from "express";
import cors from "cors";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readdir, readFile, writeFile, mkdir, copyFile, access, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const execAsync = promisify(execCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_ROOT = path.resolve(__dirname, "..");
const AGENTS_DIR = path.join(FLEET_ROOT, "agents");
const TEMPLATES_DIR = path.join(FLEET_ROOT, "templates");
const SHARED_SKILLS_DIR = path.join(FLEET_ROOT, "shared-skills");
const PORT_BASE = 18700;

const RELAY_PORT = parseInt(process.env.RELAY_PORT || "3400", 10);
const RELAY_API_KEY = process.env.RELAY_API_KEY || "";

const EXEC_ENV = { ...process.env, DOCKER_CLI_HINTS: "false" };

// ─── Helpers ────────────────────────────────────────────

function run(cmd, { timeout = 30000, cwd = FLEET_ROOT } = {}) {
  return execAsync(cmd, { timeout, cwd, env: EXEC_ENV, maxBuffer: 10 * 1024 * 1024 });
}

function containerName(agentId) {
  return `openclaw-${agentId}`;
}

function parseIdentityField(content, field) {
  const regex = new RegExp(`^- \\*\\*${field}:\\*\\*\\s*(.+)$`, "m");
  return content.match(regex)?.[1]?.trim() ?? "";
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function safeReadFile(p) {
  try { return await readFile(p, "utf-8"); } catch { return null; }
}

async function safeReadJson(p) {
  try { return JSON.parse(await readFile(p, "utf-8")); } catch { return null; }
}

async function loadEnvFile() {
  const vars = {};
  try {
    const content = await readFile(path.join(FLEET_ROOT, ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  } catch { /* .env missing */ }
  return vars;
}

async function checkHealth(port) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/__openclaw__/health`, { signal: controller.signal });
    clearTimeout(t);
    return { running: true, healthy: res.ok };
  } catch {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://localhost:${port}/`, { signal: controller.signal });
      clearTimeout(t);
      return { running: res.ok || res.status === 401, healthy: res.ok };
    } catch {
      return { running: false, healthy: false };
    }
  }
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const RANDOM_NAMES = ["Cipher","Nyx","Axiom","Glitch","Prism","Rune","Echo","Drift","Flux","Shade","Vex","Spark","Haze","Pixel","Crux","Ember","Nova","Bolt","Frost","Dusk","Blitz","Quirk","Zephyr","Onyx","Iris","Jinx","Koda","Lumen","Moxie","Nimbus","Orbit","Pulse","Riddle","Silo","Torque","Umbra","Verge","Wren","Zenith","Aether"];
const RANDOM_VIBES = ["sharp, curious, slightly contrarian","chaotic, funny, irreverent","calm, thoughtful, philosophical","sarcastic, witty, observant","warm, encouraging, nerdy","blunt, logical, no-nonsense","playful, creative, whimsical","intense, passionate, deep-thinking","dry humor, analytical, precise","chill, laid-back, insightful"];
const RANDOM_INTERESTS = ["AI ethics, philosophy, open source","memes, internet culture, gaming","science, astronomy, futurism","art, design, creative coding","history, politics, debate","music, film, pop culture","programming, systems design, math","psychology, behavior, decision-making","startups, economics, strategy","nature, ecology, sustainability"];
const RANDOM_EMOJIS = ["🔺","🌀","⚡","🧿","🎭","🦊","🐙","🌶","💎","🛸","🧠","🎲","🔮","🌊","🍄"];

// ─── Agent Discovery ────────────────────────────────────

async function discoverAgent(agentId) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  const config = await safeReadJson(path.join(agentDir, "openclaw.json"));
  if (!config) throw new Error(`Agent config not found: ${agentId}`);

  let name = agentId, vibe = "", emoji = "";
  const identity = await safeReadFile(path.join(agentDir, "workspace", "IDENTITY.md"));
  if (identity) {
    name = parseIdentityField(identity, "Name") || agentId;
    vibe = parseIdentityField(identity, "Vibe");
    emoji = parseIdentityField(identity, "Emoji");
  }

  let moltbookName = null, moltbookRegistered = false, moltbookClaimUrl = null, moltbookClaimStatus = "unclaimed";
  const creds = await safeReadFile(path.join(agentDir, "workspace", "skills", "moltbook", ".credentials"));
  if (creds) {
    const keyMatch = creds.match(/^MOLTBOOK_API_KEY=(.+)$/m);
    const nameMatch = creds.match(/^MOLTBOOK_AGENT_NAME=(.+)$/m);
    const claimUrlMatch = creds.match(/^MOLTBOOK_CLAIM_URL=(.+)$/m);
    if (keyMatch?.[1]) {
      moltbookRegistered = true;
      moltbookName = nameMatch?.[1] ?? null;
      moltbookClaimUrl = claimUrlMatch?.[1] ?? null;
      moltbookClaimStatus = "pending_claim";
    }
  }

  let cronJobCount = 0;
  const cronData = await safeReadJson(path.join(agentDir, "cron", "jobs.json"));
  if (cronData) {
    cronJobCount = (cronData.jobs ?? []).filter(j => j.enabled).length;
  }

  const currentModel = config.agents?.defaults?.model?.primary ?? "unknown";
  const availableModels = [];
  const providers = config.models?.providers ?? {};
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const model of provider.models ?? []) {
      availableModels.push({
        id: model.id,
        name: model.name,
        provider: providerKey,
        fullId: `${providerKey}/${model.id}`,
      });
    }
  }

  const heartbeatEvery = config.agents?.defaults?.heartbeat?.every ?? null;

  return {
    id: agentId,
    name,
    vibe,
    emoji,
    port: config.gateway?.port ?? 0,
    gatewayToken: config.gateway?.auth?.token ?? "",
    moltbookName,
    moltbookRegistered,
    moltbookClaimUrl,
    moltbookClaimStatus,
    currentModel,
    availableModels,
    heartbeatEvery,
    cronJobCount,
  };
}

// ─── File Scanner ───────────────────────────────────────

const SKIP_DIRS = new Set(["canvas", "logs", "node_modules", ".openclaw"]);
const SKIP_EXTENSIONS = new Set([".bak", ".log"]);
const SKIP_FILES = new Set(["update-check.json"]);

function classifyFile(relPath) {
  const parts = relPath.split("/");
  const fileName = parts[parts.length - 1];

  if (SKIP_FILES.has(fileName)) return null;
  if (SKIP_EXTENSIONS.has(path.extname(fileName))) return null;
  if (parts.some(p => SKIP_DIRS.has(p))) return null;

  if (parts[0] === "workspace") {
    const wsRel = parts.slice(1).join("/");
    if (parts[1] === "skills" && parts.length > 2) {
      return { group: "skill", name: parts.slice(2).join("/") };
    }
    return { group: "workspace", name: wsRel };
  }

  if (relPath === "openclaw.json" || parts[0] === "cron") {
    return { group: "config", name: relPath };
  }

  if (parts[0] === "agents" && parts.length > 1) {
    if (relPath.endsWith(".jsonl")) return null;
    return { group: "internal", name: relPath, readonly: true };
  }

  if (parts[0] === "devices" || parts[0] === "identity" || parts[0] === "credentials") {
    return { group: "internal", name: relPath, readonly: true };
  }

  return null;
}

async function scanDir(dir, prefix) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          results.push(...await scanDir(path.join(dir, entry.name), rel));
        }
      } else {
        results.push(rel);
      }
    }
  } catch { /* dir missing */ }
  return results;
}

// ─── Docker Compose Generation ──────────────────────────

async function generateDockerCompose() {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agentIds = entries
    .filter(e => e.isDirectory() && e.name.startsWith("agent-"))
    .map(e => e.name)
    .sort();

  if (agentIds.length === 0) return;

  let yaml = "services:\n";
  for (const agentId of agentIds) {
    const config = await safeReadJson(path.join(AGENTS_DIR, agentId, "openclaw.json"));
    const port = config?.gateway?.port;
    if (!port) continue;

    yaml += `  ${agentId}:\n`;
    yaml += `    image: openclaw-fleet:latest\n`;
    yaml += `    build: .\n`;
    yaml += `    container_name: openclaw-${agentId}\n`;
    yaml += `    volumes:\n`;
    yaml += `      - ./agents/${agentId}:/home/openclaw/.openclaw\n`;
    yaml += `    ports:\n`;
    yaml += `      - "${port}:${port}"\n`;
    yaml += `    env_file:\n`;
    yaml += `      - .env\n`;
    yaml += `    restart: unless-stopped\n`;
    yaml += `    healthcheck:\n`;
    yaml += `      test: ["CMD", "openclaw", "gateway", "health"]\n`;
    yaml += `      interval: 30s\n`;
    yaml += `      timeout: 10s\n`;
    yaml += `      retries: 3\n`;
    yaml += `      start_period: 15s\n`;
  }

  await writeFile(path.join(FLEET_ROOT, "docker-compose.yml"), yaml, "utf-8");
}

// ─── Moltbook Skill Installer ───────────────────────────

async function installMoltbookSkill(agentId) {
  const skillDir = path.join(AGENTS_DIR, agentId, "workspace", "skills", "moltbook");
  await mkdir(skillDir, { recursive: true });

  const fleetSrc = path.join(SHARED_SKILLS_DIR, "moltbook", "fleet");
  const officialSrc = path.join(SHARED_SKILLS_DIR, "moltbook");

  const copies = [
    [path.join(fleetSrc, "SKILL.md"), path.join(skillDir, "SKILL.md")],
    [path.join(fleetSrc, "API.md"), path.join(skillDir, "API.md")],
    [path.join(officialSrc, "HEARTBEAT.md"), path.join(skillDir, "HEARTBEAT.md")],
    [path.join(officialSrc, "MESSAGING.md"), path.join(skillDir, "MESSAGING.md")],
    [path.join(officialSrc, "RULES.md"), path.join(skillDir, "RULES.md")],
  ];

  for (const [src, dst] of copies) {
    if (await fileExists(src)) await copyFile(src, dst);
  }

  const credsPath = path.join(skillDir, ".credentials");
  if (!(await fileExists(credsPath))) {
    await writeFile(credsPath, "", "utf-8");
  }
}

// ─── Startup Readiness + Docker Watchdog ─────────────────

let dockerReady = false;
let dockerLastCheck = 0;
let dockerLastOk = false;
const DOCKER_CHECK_INTERVAL = 60_000;

async function checkDocker() {
  try {
    await run("docker info", { timeout: 10000 });
    dockerLastOk = true;
    return true;
  } catch {
    dockerLastOk = false;
    return false;
  }
}

async function waitForDocker(maxWaitMs = 120_000) {
  const deadline = Date.now() + maxWaitMs;
  console.log("[Relay] Waiting for Docker daemon...");
  while (Date.now() < deadline) {
    if (await checkDocker()) {
      console.log("[Relay] Docker daemon is reachable.");
      dockerReady = true;
      return true;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.error("[Relay] Docker daemon not reachable after " + (maxWaitMs / 1000) + "s — starting anyway.");
  dockerReady = true;
  return false;
}

const dockerWatchdog = setInterval(async () => {
  const ok = await checkDocker();
  dockerLastCheck = Date.now();
  if (!ok) console.warn(`[Relay] Docker health check FAILED at ${new Date().toISOString()}`);
}, DOCKER_CHECK_INTERVAL);
dockerWatchdog.unref();

// ─── Express App ────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Request timeout: abort hung requests after 120s
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timed out (120s)" });
    }
  }, 120_000);
  res.on("close", () => clearTimeout(timer));
  next();
});

// Readiness gate: reject requests (except /api/health) until Docker is confirmed
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  if (!dockerReady) {
    return res.status(503).json({ error: "Relay starting up — waiting for Docker daemon" });
  }
  next();
});

app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  if (!RELAY_API_KEY) return next();
  const key = req.headers["x-relay-key"];
  if (key !== RELAY_API_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing X-Relay-Key" });
  }
  next();
});

// ─── 1. Health ──────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    dockerReady,
    dockerLastOk,
    dockerLastCheckAgo: dockerLastCheck ? Date.now() - dockerLastCheck : null,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── 2. Fleet Overview ──────────────────────────────────

app.get("/api/fleet", async (_req, res) => {
  try {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    const agentDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith("agent-"))
      .map(e => e.name)
      .sort();

    const agents = await Promise.all(agentDirs.map(async (agentId) => {
      try {
        const config = await discoverAgent(agentId);
        const { running, healthy } = await checkHealth(config.port);
        return { ...config, containerStatus: running ? "running" : "stopped", healthy };
      } catch (err) {
        return {
          id: agentId, name: agentId, vibe: "", emoji: "", port: 0,
          gatewayToken: "", moltbookName: null, moltbookRegistered: false,
          moltbookClaimUrl: null, moltbookClaimStatus: "unknown",
          currentModel: "unknown", availableModels: [], heartbeatEvery: null,
          cronJobCount: 0, containerStatus: "stopped", healthy: false,
        };
      }
    }));

    const totalRunning = agents.filter(a => a.containerStatus === "running").length;
    res.json({ agents, totalRunning, totalStopped: agents.length - totalRunning, totalAgents: agents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Single Agent Status ─────────────────────────────

app.get("/api/agents/:id", async (req, res) => {
  try {
    const config = await discoverAgent(req.params.id);
    const { running, healthy } = await checkHealth(config.port);
    res.json({ ...config, containerStatus: running ? "running" : "stopped", healthy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Container Control ───────────────────────────────

app.post("/api/agents/:id/control", async (req, res) => {
  try {
    const { action } = req.body;
    if (!["start", "stop", "restart"].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Use start, stop, or restart." });
    }
    const { stdout } = await run(`docker compose ${action} ${req.params.id} 2>&1`);
    res.json({ result: stdout.trim() || `${action} completed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 5. Send Message ────────────────────────────────────

app.post("/api/agents/:id/message", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: "sessionId and message are required" });
    }

    const config = await discoverAgent(req.params.id);
    const name = containerName(req.params.id);
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const start = Date.now();

    const { stdout } = await run(
      `docker exec ${name} openclaw agent --session-id "${sessionId}" -m "${escaped}" --json`,
      { timeout: 120000 }
    );

    const result = JSON.parse(stdout);
    const rawPayloads = result.result?.payloads ?? [];
    const meta = result.result?.meta?.agentMeta;
    const payloads = rawPayloads
      .filter(p => p.text?.trim())
      .map((p, i, arr) => ({ text: p.text.trim(), isFinal: i === arr.length - 1 }));
    if (payloads.length === 0) payloads.push({ text: "(no response)", isFinal: true });

    res.json({
      payloads,
      durationMs: result.result?.meta?.durationMs ?? (Date.now() - start),
      model: meta ? `${meta.provider}/${meta.model}` : "unknown",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 6. Container Logs ──────────────────────────────────

app.get("/api/agents/:id/logs", async (req, res) => {
  try {
    const tail = parseInt(req.query.tail || "50", 10);
    const name = containerName(req.params.id);
    const { stdout } = await run(`docker logs ${name} --tail ${tail} 2>&1`);
    res.json({ logs: stdout });
  } catch (err) {
    res.json({ logs: "(container not running or not found)" });
  }
});

// ─── 7. Session List ────────────────────────────────────

app.get("/api/agents/:id/sessions", async (req, res) => {
  try {
    const name = containerName(req.params.id);
    const sessionsDir = "/home/openclaw/.openclaw/agents/main/sessions";
    let sessions = [];
    const knownSessionIds = new Set();

    try {
      const { stdout } = await run(`docker exec ${name} openclaw sessions --json`);
      const data = JSON.parse(stdout);
      sessions = (data.sessions ?? []).map(s => ({
        key: s.key ?? "",
        sessionId: s.sessionId ?? "",
        updatedAt: s.updatedAt ?? 0,
        model: s.model,
      }));
      for (const s of sessions) knownSessionIds.add(s.sessionId);
    } catch { /* fall through */ }

    try {
      const { stdout: lsOut } = await run(`docker exec ${name} ls -1 --time=ctime "${sessionsDir}"`);
      for (const filename of lsOut.split("\n")) {
        if (!filename.endsWith(".jsonl")) continue;
        const sid = filename.replace(/\.jsonl$/, "");
        if (knownSessionIds.has(sid) || sid === "sessions") continue;
        let updatedAt = 0;
        try {
          const { stdout: statOut } = await run(
            `docker exec ${name} stat -c %Y "${sessionsDir}/${filename}"`,
            { timeout: 5000 }
          );
          updatedAt = parseInt(statOut.trim(), 10) * 1000;
        } catch { /* use 0 */ }
        sessions.push({ key: `agent:main:${sid}`, sessionId: sid, updatedAt });
      }
    } catch { /* ignore scan errors */ }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 8. Session History ─────────────────────────────────

app.get("/api/agents/:id/history/:sessionId", async (req, res) => {
  try {
    const name = containerName(req.params.id);
    const sessionsDir = "/home/openclaw/.openclaw/agents/main/sessions";
    const escaped = req.params.sessionId.replace(/"/g, "");

    const { stdout } = await run(
      `docker exec ${name} cat "${sessionsDir}/${escaped}.jsonl"`
    );

    const messages = [];
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
          text = content
            .filter(c => c.type === "text")
            .map(c => c.text ?? "")
            .join("\n");
        }
        text = text.replace(/^\[.*?\]\s*/, "").trim();
        if (text) messages.push({ role, text });
      } catch { /* skip malformed */ }
    }

    res.json({ messages });
  } catch (err) {
    res.json({ messages: [] });
  }
});

// ─── 9. Set Model ───────────────────────────────────────

app.post("/api/agents/:id/model", async (req, res) => {
  try {
    const { modelFullId } = req.body;
    if (!modelFullId) return res.status(400).json({ error: "modelFullId is required" });

    const name = containerName(req.params.id);
    const escaped = modelFullId.replace(/"/g, '\\"');
    await run(
      `docker exec ${name} openclaw config set agents.defaults.model.primary "${escaped}"`,
      { timeout: 10000 }
    );
    await run(`docker compose restart ${req.params.id} 2>&1`);

    res.json({ model: modelFullId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 10. List Files ─────────────────────────────────────

app.get("/api/agents/:id/files", async (req, res) => {
  try {
    const root = path.join(AGENTS_DIR, req.params.id);
    const allPaths = await scanDir(root, "");
    const files = [];
    for (const rel of allPaths) {
      const classified = classifyFile(rel);
      if (!classified) continue;
      files.push({
        name: classified.name,
        relativePath: rel,
        group: classified.group,
        readonly: classified.readonly || false,
      });
    }
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 11. Read File ──────────────────────────────────────

app.get("/api/agents/:id/files/read", async (req, res) => {
  try {
    const relPath = (req.query.path || "").replace(/\.\./g, "");
    if (!relPath) return res.status(400).json({ error: "path query parameter is required" });
    const filePath = path.join(AGENTS_DIR, req.params.id, relPath);
    const content = await readFile(filePath, "utf-8");
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 12. Write File ─────────────────────────────────────

app.put("/api/agents/:id/files/write", async (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (!relPath || content === undefined) {
      return res.status(400).json({ error: "path and content are required" });
    }
    const sanitized = relPath.replace(/\.\./g, "");
    const filePath = path.join(AGENTS_DIR, req.params.id, sanitized);
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 13. Wake Agent ─────────────────────────────────────

app.post("/api/agents/:id/wake", async (req, res) => {
  try {
    const config = await discoverAgent(req.params.id);
    let { healthy } = await checkHealth(config.port);

    if (!healthy) {
      await run(`docker compose start ${req.params.id} 2>&1`);

      const maxWait = 30000;
      const interval = 2000;
      const deadline = Date.now() + maxWait;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval));
        const check = await checkHealth(config.port);
        if (check.healthy) { healthy = true; break; }
      }
    }

    res.json({ healthy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 14. Create Agents ──────────────────────────────────

async function resolveNextAgentNumber() {
  let max = 0;
  try {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith("agent-")) continue;
      const num = parseInt(e.name.replace("agent-", ""), 10);
      if (!isNaN(num) && num > max) max = num;
    }
  } catch { /* agents dir may not exist yet */ }
  return max + 1;
}

function generateUniqueName() {
  const base = pickRandom(RANDOM_NAMES);
  const suffix = crypto.randomBytes(2).toString("hex").slice(0, 3).toUpperCase();
  return `${base}_${suffix}`;
}

app.post("/api/agents/create", async (req, res) => {
  try {
    const { count = 1, name, vibe, personality, interests, emoji, purpose } = req.body;
    const created = [];
    const failed = [];

    await mkdir(AGENTS_DIR, { recursive: true });
    const envVars = await loadEnvFile();

    for (let i = 0; i < count; i++) {
      try {
        const agentNum = await resolveNextAgentNumber();
        const agentId = `agent-${String(agentNum).padStart(2, "0")}`;
        const gatewayPort = PORT_BASE + agentNum;
        const gatewayToken = crypto.randomBytes(24).toString("hex");

        const agentName = name || generateUniqueName();
        const agentVibe = vibe || pickRandom(RANDOM_VIBES);
        const agentPersonality = personality || "A unique thinker with their own perspective on the world.";
        const agentInterests = interests || pickRandom(RANDOM_INTERESTS);
        const agentEmoji = emoji || pickRandom(RANDOM_EMOJIS);
        const agentPurpose = purpose || "Community engagement and discussion";

        const agentDir = path.join(AGENTS_DIR, agentId);
        await mkdir(path.join(agentDir, "workspace", "skills"), { recursive: true });
        await mkdir(path.join(agentDir, "credentials"), { recursive: true });

        const templateVars = {
          "${CLAUDER_BASE_URL}": envVars.CLAUDER_BASE_URL || process.env.CLAUDER_BASE_URL || "https://www.ai-clauder.cc",
          "${CLAUDER_API_KEY}": envVars.CLAUDER_API_KEY || process.env.CLAUDER_API_KEY || "",
          "${GATEWAY_PORT}": String(gatewayPort),
          "${GATEWAY_TOKEN}": gatewayToken,
          "${AGENT_NAME}": agentName,
          "${AGENT_VIBE}": agentVibe,
          "${AGENT_PERSONALITY}": agentPersonality,
          "${AGENT_INTERESTS}": agentInterests,
          "${AGENT_EMOJI}": agentEmoji,
          "${AGENT_ID}": agentId,
          "${AGENT_PURPOSE}": agentPurpose,
        };

        const tplFiles = [
          ["openclaw.json.tpl", "openclaw.json"],
          ["IDENTITY.md.tpl", path.join("workspace", "IDENTITY.md")],
          ["SOUL.md.tpl", path.join("workspace", "SOUL.md")],
          ["USER.md.tpl", path.join("workspace", "USER.md")],
        ];

        for (const [tplName, outRel] of tplFiles) {
          const tplContent = await readFile(path.join(TEMPLATES_DIR, tplName), "utf-8");
          const filled = fillTemplate(tplContent, templateVars);
          await writeFile(path.join(agentDir, outRel), filled, "utf-8");
        }

        await writeFile(
          path.join(agentDir, "workspace", "HEARTBEAT.md"),
          "# Heartbeat\n\nRead and follow your Moltbook heartbeat skill at skills/moltbook/HEARTBEAT.md\n",
          "utf-8"
        );

        await installMoltbookSkill(agentId);
        await generateDockerCompose();

        await run(`docker compose up -d ${agentId} 2>&1`, { timeout: 60000 });

        created.push({ agentId, name: agentName, port: gatewayPort });
      } catch (err) {
        failed.push({ index: i, error: err.message });
      }
    }

    res.json({ created, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───────────────────────────────────────

let server;

async function start() {
  await waitForDocker();
  server = app.listen(RELAY_PORT, () => {
    console.log(`[Relay] Listening on port ${RELAY_PORT}`);
    console.log(`[Relay] Fleet root: ${FLEET_ROOT}`);
    console.log(`[Relay] Agents dir: ${AGENTS_DIR}`);
    console.log(`[Relay] Auth: ${RELAY_API_KEY ? "enabled" : "disabled (no RELAY_API_KEY set)"}`);
  });
}

function shutdown(signal) {
  console.log(`[Relay] Received ${signal}, shutting down gracefully...`);
  clearInterval(dockerWatchdog);
  if (server) {
    server.close(() => {
      console.log("[Relay] HTTP server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.warn("[Relay] Forceful shutdown after 10s timeout.");
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[Relay] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Relay] Unhandled rejection:", reason);
});

start();
