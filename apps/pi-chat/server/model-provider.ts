import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface PackyProviderSettings {
  providerId: "packy";
  baseUrl: string;
  modelId: string;
  apiKeyEnv: "PACKY_API_KEY" | "API_KEY";
}

const DEFAULT_PACKY_BASE_URL = "https://www.packyapi.ai/v1";
const DEFAULT_PACKY_MODEL_ID = "deepseek-flash";

function objectOrEmpty(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function resolvePackyProviderSettings(
  env: NodeJS.ProcessEnv = process.env,
): PackyProviderSettings | undefined {
  const apiKeyEnv = env.PACKY_API_KEY?.trim()
    ? "PACKY_API_KEY"
    : env.API_KEY?.trim()
      ? "API_KEY"
      : undefined;
  if (!apiKeyEnv) return undefined;

  return {
    providerId: "packy",
    baseUrl: env.PACKY_BASE_URL?.trim() || DEFAULT_PACKY_BASE_URL,
    modelId: env.PACKY_MODEL_ID?.trim() || DEFAULT_PACKY_MODEL_ID,
    apiKeyEnv,
  };
}

export async function ensurePackyModelsConfig(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PackyProviderSettings | undefined> {
  const settings = resolvePackyProviderSettings(env);
  if (!settings) return undefined;

  await mkdir(agentDir, { recursive: true });
  const path = join(agentDir, "models.json");
  let current: JsonObject = {};
  try {
    current = objectOrEmpty(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(
        `Unable to load Pi models config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const providers = objectOrEmpty(current.providers);
  providers[settings.providerId] = {
    name: "PackyAPI",
    api: "openai-completions",
    baseUrl: settings.baseUrl,
    apiKey: `$${settings.apiKeyEnv}`,
    models: [
      {
        id: settings.modelId,
        name: settings.modelId,
      },
    ],
  };

  const next = {
    ...current,
    providers,
  };
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return settings;
}
