import type { RuntimeExecutionService } from "@server/rca/execution-service";
import { verifyRuntimeExecutionToken } from "@server/rca/execution-auth";
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
export function createRcaRoutes(
  rcaService: RcaService,
  runtimeExecutionService?: RuntimeExecutionService,
) {
  const app = new Hono();

  if (runtimeExecutionService) {
    app.post("/executions", async (ctx) => {
    if (!verifyRuntimeExecutionToken(
      ctx.req.header("Authorization"),
      process.env.RCA_EXECUTION_API_TOKEN,
    )) {
      return ctx.json({ error: "Runtime execution API is disabled or unauthorized." }, 401);
    }

    const idempotencyKey = ctx.req.header("Idempotency-Key");
    if (!idempotencyKey) {
      return ctx.json({ error: "Idempotency-Key header is required." }, 400);
    }

    const body = await ctx.req.json<{ caseId?: unknown }>();
    if (typeof body.caseId !== "string") {
      return ctx.json({ error: "caseId must be a string." }, 400);
    }

    return ctx.json(
      await runtimeExecutionService.create({
        caseId: body.caseId,
        idempotencyKey,
      }),
      202,
    );
  });

  app.get("/executions/:runtimeExecutionId", async (ctx) => {
    if (!verifyRuntimeExecutionToken(
      ctx.req.header("Authorization"),
      process.env.RCA_EXECUTION_API_TOKEN,
    )) {
      return ctx.json({ error: "Runtime execution API is disabled or unauthorized." }, 401);
    }
    return ctx.json(
      await runtimeExecutionService.get(ctx.req.param("runtimeExecutionId")),
    );
  });

  app.post("/executions/:runtimeExecutionId/cancel", async (ctx) => {
    if (!verifyRuntimeExecutionToken(
      ctx.req.header("Authorization"),
      process.env.RCA_EXECUTION_API_TOKEN,
    )) {
      return ctx.json({ error: "Runtime execution API is disabled or unauthorized." }, 401);
    }
    return ctx.json(
      await runtimeExecutionService.cancel(ctx.req.param("runtimeExecutionId")),
    );
  });

    app.get("/investigations/:investigationId", async (ctx) => {
    return ctx.json(await rcaService.get(ctx.req.param("investigationId")));
  });
  app.get("/investigations/:investigationId/visualization", async (ctx) => {
    return ctx.json(
      await rcaService.getVisualization(ctx.req.param("investigationId")),
    );
  });
  app.post("/investigations/:investigationId/visualization/regenerate", async (ctx) => {
    return ctx.json(
      await rcaService.regenerateVisualization(ctx.req.param("investigationId")),
      202,
    );
  });
  app.get("/investigations/:investigationId/report", async (ctx) => {
    const investigationId = ctx.req.param("investigationId");
    const report = await rcaService.getReport(investigationId);
    ctx.header("Content-Type", "text/markdown; charset=utf-8");
    ctx.header(
      "Content-Disposition",
      `attachment; filename="RCA-${investigationId}.md"`,
    );
    ctx.header("Cache-Control", "private, no-store");
    return ctx.body(report);
  });
  app.post("/investigations/:investigationId/cancel", async (ctx) => {
    return ctx.json({ cancelled: await rcaService.cancel(ctx.req.param("investigationId")) });
  });
  return app;
}
