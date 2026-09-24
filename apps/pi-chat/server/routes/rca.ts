import type { RcaStreamEvent } from "../../shared/rca-types";
import type { RcaService } from "../rca/service";
import { Hono } from "hono";

export function createRcaRoutes(service: RcaService) {
  const app = new Hono();

  app.get("/incidents", (ctx) => ctx.json(service.list()));

  app.get("/incidents/:id", (ctx) => {
    const runtime = service.get(ctx.req.param("id"));
    return ctx.json(runtime.snapshot());
  });

  app.post("/incidents/:id/run", (ctx) => {
    const runtime = service.get(ctx.req.param("id"));
    void runtime.start();
    return ctx.json({ accepted: true, runId: runtime.snapshot().runId }, 202);
  });

  app.get("/incidents/:id/stream", (ctx) => {
    const runtime = service.get(ctx.req.param("id"));
    const afterQuery = ctx.req.query("after") ?? "0";
    const after = Number(afterQuery);
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const channel = runtime.channel;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        const send = (event: RcaStreamEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        for (const event of channel.after(safeAfter)) send(event);
        unsubscribe = channel.subscribe(send);
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}
