import { writeFile } from "node:fs/promises";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import { createApp } from "@server/app";
import { ConversationService } from "@server/conversation/service";
import { RCA100Adapter } from "@server/rca/adapter";
import { InvestigationRepository } from "@server/rca/repository";
import { RcaService } from "@server/rca/service";
import { ObservabilityToolRegistry } from "@server/rca/tools";

import { ensureDir, getGlobalConfig } from "./config";
import { forceClosePiTracingLifecycles } from "./observability/pi-tracing-extension";
import { settleBeforeDeadline } from "./observability/shutdown";
import { ensurePackyModelsConfig } from "./model-provider";
import { shutdownTelemetry } from "./telemetry";

const globalConfig = getGlobalConfig();
await ensureDir([globalConfig.rootDir, globalConfig.skillsDir, globalConfig.rcaInvestigationsDir]);
await writeFile(globalConfig.mcpConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), {
  flag: "wx",
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});
const packyProvider = await ensurePackyModelsConfig(getAgentDir());
if (packyProvider) {
  process.stdout.write(
    `PackyAPI provider enabled: ${packyProvider.providerId}/${packyProvider.modelId} via ${packyProvider.baseUrl}\n`,
  );
}
const modelRuntime = await ModelRuntime.create();
const rcaTools = new ObservabilityToolRegistry(new RCA100Adapter(globalConfig.rcaCasesDir));
const investigationRepository = new InvestigationRepository(globalConfig.rcaInvestigationsDir);
const recoveredInvestigations = await investigationRepository.recoverInterrupted();
if (recoveredInvestigations.length > 0) {
  process.stderr.write(
    `Recovered interrupted RCA investigations: ${recoveredInvestigations.join(", ")}\n`,
  );
}
const rcaService = new RcaService(investigationRepository, modelRuntime, rcaTools);
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

  const shutdownDeadlineMs = Math.max(
    1_000,
    Number(process.env.PI_CHAT_SHUTDOWN_TIMEOUT_MS ?? 10_000) || 10_000,
  );
  service.beginShutdown();

  let exitCode = 0;
  try {
    const closableServer = server as typeof server & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    closableServer.closeIdleConnections?.();
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    const draining = Promise.all([serverClosed, service.shutdown(shutdownDeadlineMs)]);
    const result = await settleBeforeDeadline(draining, shutdownDeadlineMs);

    const serviceTimedOut = result.value?.[1].timedOut ?? false;
    if (result.timedOut || serviceTimedOut) {
      process.stderr.write(
        `Shutdown deadline reached after ${shutdownDeadlineMs}ms; forcing incomplete telemetry close.\n`,
      );
      closableServer.closeAllConnections?.();
    }
  } catch (error) {
    exitCode = 1;
    process.stderr.write(
      `Runtime drain failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    forceClosePiTracingLifecycles("process_shutdown");
    await shutdownTelemetry();
  }

  process.exit(exitCode);
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
