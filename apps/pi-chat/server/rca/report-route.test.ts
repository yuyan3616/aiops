import assert from "node:assert/strict";
import test from "node:test";

import type { RcaService } from "./service";
import { createRcaRoutes } from "../routes/rca";

test("serves a completed RCA report as a Markdown attachment", async () => {
  const rcaService = {
    getReport: async (investigationId: string) =>
      `# RCA Report\n\nInvestigation: ${investigationId}\n`,
  } as unknown as RcaService;
  const app = createRcaRoutes(rcaService);

  const response = await app.request("/investigations/INV-test/report");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="RCA-INV-test.md"',
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(await response.text(), /Investigation: INV-test/);
});
