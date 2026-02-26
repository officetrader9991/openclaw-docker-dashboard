const ZEABUR_API = process.env.ZEABUR_API_URL || "https://api.zeabur.com/graphql";

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

function getToken() { return env("ZEABUR_API_TOKEN"); }
function getProjectId() { return env("ZEABUR_PROJECT_ID"); }
function getEnvironmentId() { return env("ZEABUR_ENVIRONMENT_ID"); }

// --- Cache for listAgentServices ---
let serviceCache: { data: AgentServiceInfo[]; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

export interface AgentServiceInfo {
  serviceId: string;
  name: string;
  status: string;
  internalHostname: string;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ZEABUR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zeabur API ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Zeabur GQL: ${json.errors[0].message}`);
  }
  return json.data as T;
}

export async function listAgentServices(bustCache = false): Promise<AgentServiceInfo[]> {
  if (!bustCache && serviceCache && Date.now() - serviceCache.ts < CACHE_TTL_MS) {
    return serviceCache.data;
  }

  const data = await gql<{
    services: { edges: { node: { _id: string; name: string; status: string } }[] };
  }>(
    `query ($projectId: ObjectID!, $environmentId: ObjectID!) {
      services(projectID: $projectId) {
        edges { node { _id name status(environmentID: $environmentId) } }
      }
    }`,
    { projectId: getProjectId(), environmentId: getEnvironmentId() }
  );

  const agents: AgentServiceInfo[] = data.services.edges
    .map((e) => e.node)
    .filter((s) => s.name.startsWith("OpenClaw-"))
    .map((s) => ({
      serviceId: s._id,
      name: s.name,
      status: s.status,
      internalHostname: `${s.name}.zeabur.internal`,
    }));

  serviceCache = { data: agents, ts: Date.now() };
  return agents;
}

export function invalidateServiceCache() {
  serviceCache = null;
}

export async function getServiceDetails(serviceId: string) {
  const data = await gql<{
    service: { _id: string; name: string; status: string; domains: { domain: string }[] };
  }>(
    `query ($serviceId: ObjectID!, $environmentId: ObjectID!) {
      service(_id: $serviceId) {
        _id
        name
        status(environmentID: $environmentId)
        domains(environmentID: $environmentId) { domain }
      }
    }`,
    { serviceId, environmentId: getEnvironmentId() }
  );
  return data.service;
}

export async function createAgentService(
  name: string,
  envVars?: Record<string, string>
): Promise<{ serviceId: string }> {
  const data = await gql<{ service: { _id: string } }>(
    `mutation ($projectId: ObjectID!, $name: String!) {
      service: createService(projectID: $projectId, template: "PREBUILT", name: $name) {
        _id
      }
    }`,
    { projectId: getProjectId(), name }
  );

  const serviceId = data.service._id;

  if (envVars) {
    await Promise.all(
      Object.entries(envVars).map(([key, value]) =>
        setServiceVariable(serviceId, key, value)
      )
    );
  }

  invalidateServiceCache();
  return { serviceId };
}

export async function controlService(
  serviceId: string,
  action: "restart" | "suspend" | "resume"
): Promise<void> {
  if (action === "restart") {
    await gql(
      `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!) {
        restartService(serviceID: $serviceId, environmentID: $environmentId)
      }`,
      { serviceId, environmentId: getEnvironmentId() }
    );
  } else if (action === "suspend") {
    await gql(
      `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!) {
        suspendService(serviceID: $serviceId, environmentID: $environmentId)
      }`,
      { serviceId, environmentId: getEnvironmentId() }
    );
  } else {
    // api.zeabur.com has no resumeService — use restartService instead
    await gql(
      `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!) {
        restartService(serviceID: $serviceId, environmentID: $environmentId)
      }`,
      { serviceId, environmentId: getEnvironmentId() }
    );
  }
}

export async function getServiceVariables(
  serviceId: string
): Promise<Record<string, string>> {
  const data = await gql<{
    service: { variables: { key: string; value: string }[] };
  }>(
    `query ($serviceId: ObjectID!, $environmentId: ObjectID!) {
      service(_id: $serviceId) {
        variables(environmentID: $environmentId) { key value }
      }
    }`,
    { serviceId, environmentId: getEnvironmentId() }
  );
  const map: Record<string, string> = {};
  for (const e of data.service.variables) map[e.key] = e.value;
  return map;
}

export async function setServiceVariable(
  serviceId: string,
  key: string,
  value: string
): Promise<void> {
  await gql(
    `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!, $key: String!, $value: String!) {
      createEnvironmentVariable(serviceID: $serviceId, environmentID: $environmentId, key: $key, value: $value) {
        key value
      }
    }`,
    { serviceId, environmentId: getEnvironmentId(), key, value }
  );
}

export async function executeCommand(
  serviceId: string,
  command: string[]
): Promise<string> {
  const data = await gql<{ result: { output: string } }>(
    `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!, $command: [String!]!) {
      result: executeCommand(serviceID: $serviceId, environmentID: $environmentId, command: $command) {
        output
      }
    }`,
    { serviceId, environmentId: getEnvironmentId(), command }
  );
  return data.result.output;
}

export async function getRuntimeLogs(serviceId: string): Promise<string> {
  const data = await gql<{
    logs: { message: string; timestamp: string }[];
  }>(
    `query ($serviceId: ObjectID!, $environmentId: ObjectID!, $projectId: ObjectID!) {
      logs: runtimeLogs(serviceID: $serviceId, environmentID: $environmentId, projectID: $projectId) {
        message
        timestamp
      }
    }`,
    {
      serviceId,
      environmentId: getEnvironmentId(),
      projectId: getProjectId(),
    }
  );
  return data.logs.map((l) => l.message).join("\n");
}

export function getInternalUrl(serviceId: string, port: number): string {
  return `http://service-${serviceId}:${port}`;
}

export async function deployService(
  serviceId: string,
  source: {
    type: "GITHUB" | "DOCKER_IMAGE";
    repoId?: number;
    ref?: string;
    dockerImage?: string;
    dockerfile?: { content?: string; path?: string };
  },
  envVars: { key: string; value: string }[] = []
): Promise<void> {
  // Set env vars first
  for (const { key, value } of envVars) {
    await setServiceVariable(serviceId, key, value);
  }

  if (source.type === "DOCKER_IMAGE" && source.dockerImage) {
    await gql(
      `mutation ($serviceId: ObjectID!, $environmentId: ObjectID!, $image: String!) {
        deployDockerImage(serviceID: $serviceId, environmentID: $environmentId, image: $image)
      }`,
      { serviceId, environmentId: getEnvironmentId(), image: source.dockerImage }
    );
  }
}
