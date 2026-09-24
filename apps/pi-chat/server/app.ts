import { Hono } from "hono";
import { cors } from "hono/cors";

import { RcaService } from "./rca/service";
import { createRcaRoutes } from "./routes/rca";

export function createApp() {
  const app = new Hono();
  const rcaService = new RcaService();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/rca", createRcaRoutes(rcaService));
  return app;
}
