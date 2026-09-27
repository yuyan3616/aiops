import type { RcaService } from "@server/rca/service";
import { Hono } from "hono";

export function createRcaRoutes(rcaService: RcaService) {
  const app = new Hono();
  app.get("/investigations/:investigationId", async (ctx) => {
    return ctx.json(await rcaService.get(ctx.req.param("investigationId")));
  });
  app.post("/investigations/:investigationId/cancel", async (ctx) => {
    return ctx.json({ cancelled: rcaService.cancel(ctx.req.param("investigationId")) });
  });
  return app;
}
