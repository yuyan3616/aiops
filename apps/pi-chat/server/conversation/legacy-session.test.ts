import assert from "node:assert/strict";
import test from "node:test";

import { RcaServiceError, type RcaService } from "@server/rca/service";
import { createConversationRoutes } from "@server/routes/conversation";

import { ConversationService } from "./service";

test("archived dataset conversation rejects messages before initializing a model or changing history", async () => {
  const service = Object.create(ConversationService.prototype) as ConversationService;
  let initialized = false;
  Object.assign(service, {
    resolveRcaContext: async () => ({ state: "completed", sourceKind: "legacy" }),
    ensureManagedSession: async () => {
      initialized = true;
      throw new Error("must not initialize a model");
    },
  });
  await assert.rejects(service.send("old-session", "继续排查"), (error: unknown) => {
    assert.ok(error instanceof RcaServiceError);
    assert.equal(error.code, "legacy_read_only");
    assert.match(error.message, /数据源已停用/);
    return true;
  });
  assert.equal(initialized, false);
  const routes = createConversationRoutes(service, {} as RcaService);
  const form = new FormData();
  form.set("text", "为什么是这个根因？");
  const response = await routes.request("/old-session/messages", { method: "POST", body: form });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { code: string; error: string };
  assert.equal(body.code, "legacy_read_only");
  assert.match(body.error, /新建 Live 会话/);
  assert.equal(initialized, false);
});
