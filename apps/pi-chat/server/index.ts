import { serve } from "@hono/node-server";

import { createApp } from "./app";

const host = process.env.PI_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.PI_CHAT_PORT ?? process.env.PORT ?? 4328);
serve({ fetch: createApp().fetch, hostname: host, port }, (info) => {
  console.log(`RCA Pi Agent server listening on http://${host}:${info.port}`);
});
