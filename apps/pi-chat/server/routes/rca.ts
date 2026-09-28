import type { RcaService } from "@server/rca/service";
import { Hono } from "hono";

/**
 * External RCA ingress / management API.
 *
 * Keep this route even when the web UI does not call it directly: it is the
 * stable HTTP boundary reserved for Alertmanager, Grafana, custom alerting
 * platforms, automation, and future incident-management integrations.
 *
 * External systems may trigger/read/cancel investigations through this layer,
 * while hypothesis management, evidence collection, specialist dispatch, and
 * conclusion remain coordinated by the Main Agent through RcaService.
 *
 * Do not move RCA orchestration logic into these HTTP handlers; keep them thin
 * adapters over the service layer.
 */
export function createRcaRoutes(rcaService: RcaService) {
  const app = new Hono();
  app.get("/investigations/:investigationId", async (ctx) => {
    return ctx.json(await rcaService.get(ctx.req.param("investigationId")));
  });
  app.post("/investigations/:investigationId/cancel", async (ctx) => {
    return ctx.json({ cancelled: await rcaService.cancel(ctx.req.param("investigationId")) });
  });
  return app;
}
