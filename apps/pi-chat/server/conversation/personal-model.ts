import { createHash, randomUUID } from "node:crypto";

import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as openAIStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PersonalModelInput {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

const DEFAULT_HOSTS = [
  "api.openai.com",
  "api.deepseek.com",
  "openrouter.ai",
  "api.groq.com",
  "www.packyapi.ai",
];

export function validatePersonalModel(
  input: PersonalModelInput,
  allowedHosts = process.env.BYOK_ALLOWED_HOSTS,
): PersonalModelInput {
  if (
    typeof input.baseUrl !== "string" ||
    typeof input.modelId !== "string" ||
    typeof input.apiKey !== "string"
  ) {
    throw new Error("Invalid model configuration");
  }
  const baseUrl = input.baseUrl.trim();
  const modelId = input.modelId.trim();
  const apiKey = input.apiKey.trim();
  if (baseUrl.length > 512 || !modelId || modelId.length > 128 || !apiKey || apiKey.length > 512) {
    throw new Error("Invalid model configuration");
  }
  if (!/^[\w./:-]+$/.test(modelId) || /[\r\n]/.test(apiKey)) {
    throw new Error("Invalid model configuration");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid model Base URL");
  }
  const hosts =
    allowedHosts === undefined
      ? DEFAULT_HOSTS
      : allowedHosts
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !hosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Model Base URL is not approved for server-side requests");
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), modelId, apiKey };
}

export function personalModelFingerprint(input: PersonalModelInput): string {
  const config = validatePersonalModel(input);
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** No disk-backed credentials or provider config. One runtime is owned by one live conversation. */
export async function createPersonalModelRuntime(input: PersonalModelInput) {
  const config = validatePersonalModel(input);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
  });
  const provider = `personal-${randomUUID()}`;
  runtime.registerProvider(provider, {
    name: "Personal model",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    streamSimple(model, context, options) {
      const output = createAssistantMessageEventStream();
      const stream = openAIStreamSimple(model as Model<"openai-completions">, context, {
        ...(options as SimpleStreamOptions),
        // An approved provider must not redirect a request into the container's private network.
        fetch: (url, init) => globalThis.fetch(url, { ...init, redirect: "error" }),
      });
      void (async () => {
        try {
          for await (const event of stream) {
            if (event.type === "error") {
              output.push({
                ...event,
                error: {
                  ...event.error,
                  content: [],
                  errorMessage:
                    "Personal model request failed; check the endpoint, credentials and quota.",
                },
              });
            } else {
              output.push(event);
            }
          }
        } catch {
          output.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: "Personal model request failed.",
              timestamp: Date.now(),
            },
          });
        }
      })();
      return output;
    },
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 4_096,
      },
    ],
  });
  return {
    runtime,
    provider,
    modelId: config.modelId,
    fingerprint: personalModelFingerprint(config),
  };
}
