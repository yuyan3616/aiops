import type { RcaService } from "@server/rca/service";
import { jsonBody } from "@server/utils";
import { Hono } from "hono";

export function createRcaRoutes(rcaService: RcaService) {
  const app = new Hono();
  app.post("/investigations", async (ctx) => {
    const body = await jsonBody<{ caseId?: unknown }>(ctx.req.raw);
    if (typeof body.caseId !== "string" || !/^t\d+$/.test(body.caseId)) {
      throw new Error("caseId must match t<number>");
    }
    const investigationId = rcaService.start(body.caseId);
    return ctx.json({ investigationId, accepted: true }, 202);
  });
  app.get("/investigations/:investigationId", async (ctx) => {
    return ctx.json(await rcaService.get(ctx.req.param("investigationId")));
  });
  app.post("/investigations/:investigationId/cancel", async (ctx) => {
    return ctx.json({ cancelled: rcaService.cancel(ctx.req.param("investigationId")) });
  });
  return app;
}
