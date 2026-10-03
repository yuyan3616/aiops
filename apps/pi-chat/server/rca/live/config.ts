import {
  LogProvider,
  MetricsProvider,
  TraceProvider,
  type ProviderSet,
} from "./providers";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function authHeaders(prefix: "TEMPO" | "LOKI" | "PROMETHEUS"): Record<string, string> {
  const headers: Record<string, string> = {};
  const bearer = optionalEnv(`${prefix}_BEARER_TOKEN`);
  const username = optionalEnv(`${prefix}_BASIC_USERNAME`);
  const password = optionalEnv(`${prefix}_BASIC_PASSWORD`);
  const tenant = optionalEnv(`${prefix}_TENANT_ID`);
  if (bearer && (username || password)) {
    throw new Error(`${prefix} auth must use either bearer or basic credentials, not both`);
  }
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (username || password) {
    if (!username || !password) {
      throw new Error(`${prefix} basic auth requires both username and password`);
    }
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  if (tenant) headers["X-Scope-OrgID"] = tenant;
  return headers;
}

export interface LiveProviderAvailability {
  trace: boolean;
  log: boolean;
  metrics: boolean;
}

export interface LiveProviderRuntime {
  providers: ProviderSet;
  availability: LiveProviderAvailability;
}

export function createLiveProvidersFromEnv(): LiveProviderRuntime {
  const tempoBaseUrl = optionalEnv("TEMPO_BASE_URL");
  const lokiBaseUrl = optionalEnv("LOKI_BASE_URL");
  const prometheusBaseUrl = optionalEnv("PROMETHEUS_BASE_URL");

  const providers: ProviderSet = {};
  if (tempoBaseUrl) {
    providers.trace = new TraceProvider({
      baseUrl: tempoBaseUrl,
      backendAlias: "tempo",
      headers: authHeaders("TEMPO"),
    });
  }
  if (lokiBaseUrl) {
    providers.log = new LogProvider({
      baseUrl: lokiBaseUrl,
      backendAlias: "loki",
      headers: authHeaders("LOKI"),
      serviceLabel: optionalEnv("LOKI_SERVICE_LABEL"),
      environmentLabel: optionalEnv("LOKI_ENVIRONMENT_LABEL"),
      containerLabel: optionalEnv("LOKI_CONTAINER_LABEL"),
    });
  }
  if (prometheusBaseUrl) {
    providers.metrics = new MetricsProvider({
      baseUrl: prometheusBaseUrl,
      backendAlias: "prometheus",
      headers: authHeaders("PROMETHEUS"),
      serviceLabel: optionalEnv("PROMETHEUS_SERVICE_LABEL"),
      environmentLabel: optionalEnv("PROMETHEUS_ENVIRONMENT_LABEL"),
      containerLabel: optionalEnv("PROMETHEUS_CONTAINER_LABEL"),
    });
  }

  return {
    providers,
    availability: {
      trace: Boolean(providers.trace),
      log: Boolean(providers.log),
      metrics: Boolean(providers.metrics),
    },
  };
}
