import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { RcaService } from "./rca/service";

const host = process.env.PI_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.PI_CHAT_PORT ?? process.env.PORT ?? 4328);
const rcaService = new RcaService();
const server = serve({ fetch: createApp(rcaService).fetch, hostname: host, port }, (info) => {
  console.log(`RCA Pi Agent server listening on http://${host}:${info.port}`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await rcaService.flushAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function handleShutdown() {
  void shutdown()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("RCA server shutdown failed", error);
      process.exit(1);
    });
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
