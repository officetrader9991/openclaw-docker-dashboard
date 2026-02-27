import { exec as execCb } from "child_process";
import { promisify } from "util";
import path from "path";
import crypto from "crypto";
import { isZeabur } from "./fleetMode";
import * as zeabur from "./zeaburService";

const execAsync = promisify(execCb);
const FLEET_ROOT = path.resolve(process.cwd(), "..");
const SCRIPT_PATH = path.join(FLEET_ROOT, "scripts", "create-agent.sh");

const EXEC_OPTS = {
  env: {
    ...process.env,
    PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    HOME: process.env.REAL_HOME || `/Users/${process.env.USER || "ozaru"}`,
    DOCKER_CLI_HINTS: "false",
  },
};

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

export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const name = input.name || generateUniqueName(0);

  if (isZeabur()) {
    return createAgentZeabur(name, input);
  }
  return createAgentDocker(name, input);
}

async function createAgentDocker(name: string, input: CreateAgentInput): Promise<CreateAgentResult> {
  const args = [`--name "${name}" --start`];

  if (input.vibe) args.push(`--vibe "${input.vibe}"`);
  else args.push(`--vibe "${pickRandom(RANDOM_VIBES)}"`);

  if (input.personality) args.push(`--personality "${input.personality}"`);
  if (input.interests) args.push(`--interests "${input.interests}"`);
  else args.push(`--interests "${pickRandom(RANDOM_INTERESTS)}"`);

  if (input.emoji) args.push(`--emoji "${input.emoji}"`);
  if (input.purpose) args.push(`--purpose "${input.purpose}"`);

  try {
    const { stdout } = await execAsync(
      `cd "${FLEET_ROOT}" && bash "${SCRIPT_PATH}" ${args.join(" ")}`,
      { timeout: 60000, ...EXEC_OPTS }
    );

    const idMatch = stdout.match(/ID:\s+(agent-\d+)/);
    const portMatch = stdout.match(/Port:\s+(\d+)/);
    const agentId = idMatch?.[1] ?? "unknown";
    const port = portMatch ? parseInt(portMatch[1]) : 0;

    return { agentId, name, port, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { agentId: "unknown", name, port: 0, success: false, error: msg };
  }
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
    if (process.env.YUNYI_API_KEY) envVars.YUNYI_API_KEY = process.env.YUNYI_API_KEY;
    if (process.env.MINIMAX_API_KEY) envVars.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
    if (process.env.ZEABUR_AI_HUB_API_KEY) envVars.ZEABUR_AI_HUB_API_KEY = process.env.ZEABUR_AI_HUB_API_KEY;

    const { serviceId } = await zeabur.createAgentService(serviceName, envVars);

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
    return { agentId: serviceName, name, port: 18789, success: true };
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
      { timeout: 30000, ...EXEC_OPTS }
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
