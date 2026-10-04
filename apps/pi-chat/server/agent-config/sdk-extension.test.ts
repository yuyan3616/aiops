import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createRcaMainHost } from "../rca/main-host";

test("installed SDK loads, binds and disposes an explicit inline tool without discovery", async () => {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) =>
        pi.registerTool({
          name: "extension_probe",
          label: "probe",
          description: "probe",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        }),
    ],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
  });
  try {
    await session.bindExtensions({});
    session.setActiveToolsByName(["extension_probe"]);
    assert.deepEqual(session.getActiveToolNames(), ["extension_probe"]);
  } finally {
    session.dispose();
  }
});

test("Main host refuses an already cancelled operation before touching Service", async () => {
  let calls = 0;
  const host = createRcaMainHost({
    rcaService: {
      get: async () => {
        calls++;
      },
    } as never,
    conversationId: "test",
    getModelRef: () => ({ provider: "test", id: "test" }),
    onProjection: () => {},
    onLinkInvestigation: () => {},
  });
  await assert.rejects(
    host.get_investigation_state("id", { investigationId: "test" }, AbortSignal.abort()),
    /abort/i,
  );
  assert.equal(calls, 0);
});
