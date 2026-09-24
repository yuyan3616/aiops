import { serve } from "@hono/node-server";

import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4328);
serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`RCA fake server listening on http://127.0.0.1:${info.port}`);
});
