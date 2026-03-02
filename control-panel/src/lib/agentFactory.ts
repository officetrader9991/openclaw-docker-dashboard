import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readdir, readFile, writeFile, mkdir, copyFile, access } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { isZeabur, isRelay } from "./fleetMode";
import * as zeabur from "./zeaburService";
import { relayPost } from "./relayClient";

const execAsync = promisify(execCb);
const FLEET_ROOT = path.resolve(process.cwd(), "..");
const AGENTS_DIR = path.join(FLEET_ROOT, "agents");
const TEMPLATES_DIR = path.join(FLEET_ROOT, "templates");
const SHARED_SKILLS_DIR = path.join(FLEET_ROOT, "shared-skills");
const PORT_BASE = 18700;

const EXEC_ENV = {
  ...process.env,
  DOCKER_CLI_HINTS: "false",
};

async function loadEnvFile(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
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

const RANDOM_NAMES = [
  "Cipher", "Nyx", "Axiom", "Glitch", "Prism", "Rune", "Echo", "Drift",
  "Flux", "Shade", "Vex", "Spark", "Haze", "Pixel", "Crux", "Ember",
  "Nova", "Bolt", "Frost", "Dusk", "Blitz", "Quirk", "Zephyr", "Onyx",
  "Iris", "Jinx", "Koda", "Lumen", "Moxie", "Nimbus", "Orbit", "Pulse",
  "Riddle", "Silo", "Torque", "Umbra", "Verge", "Wren", "Zenith", "Aether",
];

const RANDOM_VIBES = [
  "sharp, curious, slightly contrarian",
  "chaotic, funny, irreverent",
  "calm, thoughtful, philosophical",
  "sarcastic, witty, observant",
  "warm, encouraging, nerdy",
  "blunt, logical, no-nonsense",
  "playful, creative, whimsical",
  "intense, passionate, deep-thinking",
  "dry humor, analytical, precise",
  "chill, laid-back, insightful",
];

const RANDOM_INTERESTS = [
  "AI ethics, philosophy, open source",
  "memes, internet culture, gaming",
  "science, astronomy, futurism",
  "art, design, creative coding",
  "history, politics, debate",
  "music, film, pop culture",
  "programming, systems design, math",
  "psychology, behavior, decision-making",
  "startups, economics, strategy",
  "nature, ecology, sustainability",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateUniqueName(existingSuffix: number): string {
  const base = pickRandom(RANDOM_NAMES);
  const suffix = crypto.randomBytes(2).toString("hex").slice(0, 3).toUpperCase();
  return `${base}_${suffix}`;
}

export interface CreateAgentInput {
  name?: string;
  vibe?: string;
  personality?: string;
  interests?: string;
  emoji?: string;
  purpose?: string;
}

export interface CreateAgentResult {
  agentId: string;
  name: string;
  port: number;
  success: boolean;
  error?: string;
}

async function createAgentRelay(name: string, input: CreateAgentInput): Promise<CreateAgentResult> {
  try {
    const res = await relayPost<{ created: CreateAgentResult[]; failed: CreateAgentResult[] }>("/api/agents/create", {
      count: 1, name, ...input,
    }, 60000);
    return res.created[0] ?? res.failed[0] ?? { agentId: "unknown", name, port: 0, success: false, error: "No result" };
  } catch (err) {
    return { agentId: "unknown", name, port: 0, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const name = input.name || generateUniqueName(0);

  if (isRelay()) return createAgentRelay(name, input);
  if (isZeabur()) {
    return createAgentZeabur(name, input);
  }
  return createAgentDocker(name, input);
}

async function resolveNextAgentNumber(): Promise<number> {
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

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function installMoltbookSkill(agentId: string): Promise<void> {
  const skillDir = path.join(AGENTS_DIR, agentId, "workspace", "skills", "moltbook");
  await mkdir(skillDir, { recursive: true });

  const fleetSrc = path.join(SHARED_SKILLS_DIR, "moltbook", "fleet");
  const officialSrc = path.join(SHARED_SKILLS_DIR, "moltbook");

  const copies: [string, string][] = [
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

async function generateDockerCompose(): Promise<void> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agentIds = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("agent-"))
    .map((e) => e.name)
    .sort();

  if (agentIds.length === 0) return;

  let yaml = "services:\n";
  for (const agentId of agentIds) {
    const configPath = path.join(AGENTS_DIR, agentId, "openclaw.json");
    let port = 0;
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      port = config.gateway?.port ?? 0;
    } catch { continue; }
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

async function createAgentDocker(name: string, input: CreateAgentInput): Promise<CreateAgentResult> {
  try {
    await mkdir(AGENTS_DIR, { recursive: true });
    const agentNum = await resolveNextAgentNumber();
    const agentId = `agent-${String(agentNum).padStart(2, "0")}`;
    const gatewayPort = PORT_BASE + agentNum;
    const gatewayToken = crypto.randomBytes(24).toString("hex");

    const vibe = input.vibe || pickRandom(RANDOM_VIBES);
    const personality = input.personality || "A unique thinker with their own perspective on the world.";
    const interests = input.interests || pickRandom(RANDOM_INTERESTS);
    const emoji = input.emoji || pickRandomEmoji();
    const purpose = input.purpose || "Community engagement and discussion";

    const agentDir = path.join(AGENTS_DIR, agentId);
    await mkdir(path.join(agentDir, "workspace", "skills"), { recursive: true });
    await mkdir(path.join(agentDir, "credentials"), { recursive: true });

    const envVars = await loadEnvFile();

    const templateVars: Record<string, string> = {
      "${CLAUDER_BASE_URL}": envVars.CLAUDER_BASE_URL || process.env.CLAUDER_BASE_URL || "https://www.ai-clauder.cc",
      "${CLAUDER_API_KEY}": envVars.CLAUDER_API_KEY || process.env.CLAUDER_API_KEY || "",
      "${GATEWAY_PORT}": String(gatewayPort),
      "${GATEWAY_TOKEN}": gatewayToken,
      "${AGENT_NAME}": name,
      "${AGENT_VIBE}": vibe,
      "${AGENT_PERSONALITY}": personality,
      "${AGENT_INTERESTS}": interests,
      "${AGENT_EMOJI}": emoji,
      "${AGENT_ID}": agentId,
      "${AGENT_PURPOSE}": purpose,
    };

    const tplFiles: [string, string][] = [
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

    await execAsync(
      `docker compose up -d ${agentId}`,
      { timeout: 60000, cwd: FLEET_ROOT, env: EXEC_ENV }
    );

    return { agentId, name, port: gatewayPort, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { agentId: "unknown", name, port: 0, success: false, error: msg };
  }
}

const RANDOM_EMOJIS = ["🔺", "🌀", "⚡", "🧿", "🎭", "🦊", "🐙", "🌶", "💎", "🛸", "🧠", "🎲", "🔮", "🌊", "🍄"];

function pickRandomEmoji(): string {
  return pickRandom(RANDOM_EMOJIS);
}

async function createAgentZeabur(name: string, input: CreateAgentInput): Promise<CreateAgentResult> {
  try {
    // Count existing agents to generate service name
    const existing = await zeabur.listAgentServices(true);
    const num = existing.length + 1;
    const serviceName = `OpenClaw-${String(num).padStart(3, "0")}`;
    const gatewayToken = crypto.randomUUID();

    // Create service with env vars matching OpenClaw-001 setup
    const envVars: Record<string, string> = {
      PASSWORD: gatewayToken,
      OPENCLAW_GATEWAY_TOKEN: "${PASSWORD}",
      OPENCLAW_GATEWAY_BIND: "lan",
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "true",
      NODE_OPTIONS: "--max-old-space-size=1024",
      NODE_ENV: "production",
      OPENCLAW_STATE_DIR: "/home/node/.openclaw",
      OPENCLAW_WORKSPACE_DIR: "/home/node/.openclaw/workspace",
    };

    // Copy provider keys from dashboard env if available
    if (process.env.CLAUDER_API_KEY) envVars.CLAUDER_API_KEY = process.env.CLAUDER_API_KEY;
    if (process.env.MINIMAX_API_KEY) envVars.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
    if (process.env.ZEABUR_AI_HUB_API_KEY) envVars.ZEABUR_AI_HUB_API_KEY = process.env.ZEABUR_AI_HUB_API_KEY;

    const { serviceId, actualName } = await zeabur.createAgentService(serviceName, envVars);
    const resolvedServiceName = actualName;

    // Set port 18789 as HTTP
    await zeabur.updateServicePorts(serviceId, [{ id: "web", port: 18789, type: "HTTP" }]);

    // Deploy using the official OpenClaw image
    await zeabur.deployService(serviceId, {
      type: "DOCKER_IMAGE",
      dockerImage: "ghcr.io/openclaw/openclaw:latest",
    });

    // Best-effort write identity after a short delay for service to start
    const vibe = input.vibe || pickRandom(RANDOM_VIBES);
    const interests = input.interests || pickRandom(RANDOM_INTERESTS);
    const emoji = input.emoji || "";
    const purpose = input.purpose || "";

    const identityMd = [
      "# Agent Identity",
      `- **Name:** ${name}`,
      `- **Vibe:** ${vibe}`,
      emoji ? `- **Emoji:** ${emoji}` : null,
      interests ? `- **Interests:** ${interests}` : null,
      purpose ? `- **Purpose:** ${purpose}` : null,
    ].filter(Boolean).join("\n");

    try {
      await zeabur.executeCommand(serviceId, [
        "sh", "-c",
        `mkdir -p /home/node/.openclaw/workspace && printf '%s' '${identityMd.replace(/'/g, "'\\''")}' > /home/node/.openclaw/workspace/IDENTITY.md`,
      ]);
    } catch { /* service may not be ready yet — identity can be set later */ }

    zeabur.invalidateServiceCache();
    return { agentId: resolvedServiceName, name, port: 18789, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { agentId: "unknown", name, port: 0, success: false, error: msg };
  }
}

export async function createAgentsBulk(
  count: number,
  sharedInput: CreateAgentInput
): Promise<CreateAgentResult[]> {
  const results: CreateAgentResult[] = [];

  for (let i = 0; i < count; i++) {
    const input = { ...sharedInput };
    if (!input.name) input.name = generateUniqueName(i);
    const result = await createAgent(input);
    results.push(result);
    if (!input.name) sharedInput.name = undefined;
  }

  return results;
}

export interface MoltbookRegisterResult {
  success: boolean;
  registeredName?: string;
  claimUrl?: string;
  error?: string;
}

export async function registerOnMoltbook(
  agentId: string,
  moltbookName?: string
): Promise<MoltbookRegisterResult> {
  const registerScript = path.join(FLEET_ROOT, "scripts", "register-moltbook.sh");
  const nameFlag = moltbookName ? `--name "${moltbookName}"` : "";

  try {
    const { stdout } = await execAsync(
      `cd "${FLEET_ROOT}" && bash "${registerScript}" --agent ${agentId} ${nameFlag}`,
      { timeout: 30000, env: EXEC_ENV }
    );

    const claimMatch = stdout.match(/Claim URL:\s+(https:\/\/\S+)/);
    const nameMatch = stdout.match(/Agent:\s+(\S+)/);
    const alreadyRegistered = stdout.includes("already registered");

    if (alreadyRegistered) {
      const existingName = stdout.match(/API Key:\s/);
      return { success: true, error: "Already registered" };
    }

    return {
      success: true,
      registeredName: nameMatch?.[1] || moltbookName,
      claimUrl: claimMatch?.[1],
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr || "";
    const stdout = (err as { stdout?: string })?.stdout || "";
    const combined = raw + stderr + stdout;

    if (combined.includes("already registered"))
      return { success: true, error: "Already registered" };
    if (combined.includes("Rate limit") || combined.includes("429"))
      return { success: false, error: "Moltbook rate limit — try again later" };
    if (combined.includes("already taken") || combined.includes("409"))
      return { success: false, error: "Name already taken on Moltbook" };
    if (combined.includes("500") || combined.includes("Internal server"))
      return { success: false, error: "Moltbook server error — try again" };

    const responseMatch = combined.match(/Response:\s*(\{.+\})/);
    if (responseMatch) {
      try {
        const parsed = JSON.parse(responseMatch[1]);
        return { success: false, error: parsed.message || "Registration failed" };
      } catch { /* fall through */ }
    }

    return { success: false, error: "Registration failed — check logs" };
  }
}
