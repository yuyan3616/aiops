import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationService } from "./service";
import type { RcaService } from "@server/rca/service";
import { createConversationRoutes } from "@server/routes/conversation";

test("batch delete validates ids and forwards unique conversation ids", async () => {
  const calls: string[][] = [];
  const conversationService = {
    deleteMany: async (ids: string[]) => {
      calls.push(ids);
      return ids;
    },
  } as unknown as ConversationService;
  const app = createConversationRoutes(
    conversationService,
    {} as RcaService,
  );

  const response = await app.request("/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["c1", "c2", "c1"] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["c1", "c2"]]);
  assert.deepEqual(await response.json(), { deletedIds: ["c1", "c2"] });
});

test("batch delete rejects an empty id list", async () => {
  const conversationService = {
    deleteMany: async () => {
      throw new Error("should not be called");
    },
  } as unknown as ConversationService;
  const app = createConversationRoutes(
    conversationService,
    {} as RcaService,
  );

  const response = await app.request("/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });

  assert.equal(response.status, 500);
});
