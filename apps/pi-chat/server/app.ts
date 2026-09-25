import { Hono } from "hono";
import { cors } from "hono/cors";

import { RcaService } from "./rca/service";
import { createRcaRoutes } from "./routes/rca";

export function createApp(rcaService = new RcaService()) {
  const app = new Hono();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/rca", createRcaRoutes(rcaService));
  return app;
}
