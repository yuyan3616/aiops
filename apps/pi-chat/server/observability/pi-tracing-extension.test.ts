import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { createPiTracingExtension } from "./pi-tracing-extension";

test("Pi tracing extension registers V1 lifecycle hooks", async () => {
  const events: string[] = [];
  const pi = {
    on(event: string) {
      events.push(event);
      return () => undefined;
    },
  } as unknown as Parameters<ExtensionFactory>[0];

  await createPiTracingExtension({ conversationId: "conversation-test" })(pi);

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "before_provider_headers",
    "after_provider_response",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "agent_settled",
  ]);
});
