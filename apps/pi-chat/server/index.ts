import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import { createApp } from "@server/app";
import { ConversationService } from "@server/conversation/service";
import { createLiveProvidersFromEnv } from "@server/rca/live/config";
import { InvestigationRepository } from "@server/rca/repository";
import { RcaService } from "@server/rca/service";
import { ObservabilityToolRegistry } from "@server/rca/tools";

import { agentConfigStore } from "./agent-config/store";
import { ensureDir, getGlobalConfig } from "./config";
import { ensurePackyModelsConfig } from "./model-provider";

const globalConfig = getGlobalConfig();
await ensureDir([globalConfig.rootDir, globalConfig.skillsDir, globalConfig.rcaInvestigationsDir]);
await writeFile(globalConfig.mcpConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), {
  flag: "wx",
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});
await agentConfigStore.start({
  cacheDir: join(globalConfig.rootDir, "agent-config"),
  repository: process.env.AGENT_CONFIG_REPOSITORY,
  ref: process.env.AGENT_CONFIG_REF ?? "main",
  token: process.env.AGENT_CONFIG_GITHUB_TOKEN,
});
process.stdout.write(`Agent configuration status: ${JSON.stringify(agentConfigStore.status)}\n`);
const packyProvider = await ensurePackyModelsConfig(getAgentDir());
if (packyProvider) {
  process.stdout.write(
    `PackyAPI provider enabled: ${packyProvider.providerId}/${packyProvider.modelId} via ${packyProvider.baseUrl}\n`,
  );
}
const modelRuntime = await ModelRuntime.create();
const liveRuntime = createLiveProvidersFromEnv();
const rcaTools = new ObservabilityToolRegistry(liveRuntime.providers);
process.stdout.write(
  `Live observability capabilities: ${JSON.stringify(liveRuntime.availability)}\n`,
);
const investigationRepository = new InvestigationRepository(globalConfig.rcaInvestigationsDir);
const recoveredInvestigations = await investigationRepository.recoverInterrupted();
if (recoveredInvestigations.length > 0) {
  process.stderr.write(
    `Recovered interrupted RCA investigations: ${recoveredInvestigations.join(", ")}\n`,
  );
}
const repairedProjections = await investigationRepository.recoverProjections();
if (repairedProjections.length > 0) {
  process.stderr.write(`Repaired RCA event projections: ${repairedProjections.join(", ")}\n`);
}
const rcaService = new RcaService(investigationRepository, modelRuntime, rcaTools);
const recoveredReports = await rcaService.recoverReports();
if (recoveredReports.length > 0) {
  process.stderr.write(`Recovered missing RCA reports: ${recoveredReports.join(", ")}\n`);
}
const recoveredVisualizations = await rcaService.recoverVisualizations();
if (recoveredVisualizations.length > 0) {
  process.stderr.write(
    `Recovered pending RCA visualizations: ${recoveredVisualizations.join(", ")}\n`,
  );
}
const service = new ConversationService(globalConfig, modelRuntime, rcaService);

const app = createApp(service, rcaService);
const host = process.env.PI_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.PI_CHAT_PORT ?? 4328);
const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  (info) => {
    process.stdout.write(`Pi Chat API listening on http://${host}:${info.port}\n`);
  },
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  agentConfigStore.stop();
  service.close();
  server.close(() => process.exit(0));
}

function handleShutdown() {
  shutdown().catch((error) => {
    process.stderr.write(
      `Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
