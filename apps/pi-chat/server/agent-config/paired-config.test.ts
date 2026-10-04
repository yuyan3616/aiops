import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";

import { createRcaMainHost } from "../rca/main-host";
import { PiExpertRunner } from "../rca/pi-expert";
import { InvestigationRepository } from "../rca/repository";
import { RcaService } from "../rca/service";
import type { ObservabilityToolRegistry } from "../rca/tools";
import { readConfigDirectory } from "./local-files";
import { AgentConfigStore, agentConfigStore } from "./store";
import { fixtureFiles, TEST_CONFIG_VERSION } from "./test-fixture";

const directory = process.env.AGENT_CONFIG_TEST_DIRECTORY;
test(
  "candidate repositories register real Main tools, create an investigation and preserve its version",
  { skip: !directory },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paired-main-"));
    try {
      const store = new AgentConfigStore({ cacheDir: join(root, "config") }),
        version = "a".repeat(40);
      const bundle = await store.install(version, readConfigDirectory(directory!));
      // Service also resolves this fixed bundle, exactly as the production process does.
      await agentConfigStore.install(version, readConfigDirectory(directory!));
      const service = new RcaService(new InvestigationRepository(join(root, "rca")));
      const host = createRcaMainHost({
        rcaService: service,
        conversationId: "paired",
        getAgentConfigVersion: () => version,
        getModelRef: () => ({ provider: "test", id: "test" }),
        onProjection: () => {},
        onLinkInvestigation: () => {},
      });
      const tools = await store.toolsFor(version, "main", host);
      assert.deepEqual(
        tools.map((x) => x.name),
        bundle.roles.main!.tools,
      );
      const start = tools.find((x) => x.name === "start_rca_investigation")!;
      const result = await start.execute(
        "start",
        { symptom: "latency", target: { service: "checkout" }, window: { lookbackMinutes: 10 } },
        undefined,
        undefined,
        {} as never,
      );
      const state = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(state.agentConfigVersion, version);
      assert.equal(state.expertTasks.length, 0);
      assert.equal((await service.get(state.investigationId)).agentConfigVersion, version);
      assert.ok((start.parameters as { properties?: unknown }).properties);
    } finally {
      agentConfigStore.activate(TEST_CONFIG_VERSION, fixtureFiles());
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real Expert Extension cannot submit before Finalize and submits a valid finding in the same session",
  { skip: !directory },
  async () => {
    const version = "b".repeat(40);
    await agentConfigStore.install(version, readConfigDirectory(directory!));
    let active: string[] = [],
      prompts = 0;
    const createSession = (async (
      options: NonNullable<Parameters<typeof createAgentSession>[0]>,
    ) => {
      const tools = options
        .resourceLoader!.getExtensions()
        .extensions.flatMap((e) => [...e.tools.values()].map((t) => t.definition));
      const submit = tools.find((t) => t.name === "submit_finding")!;
      const finding = {
        status: "succeeded",
        strength: "inconclusive",
        verdict: "no-signal",
        summary: "无可确认信号",
        conclusions: [],
        evidenceClaims: [],
        candidateEntities: [],
        suggestedFollowUps: [],
      };
      return {
        session: {
          sessionManager: { getSessionId: () => "paired-expert" },
          setActiveToolsByName: (names: string[]) => {
            active = names;
          },
          subscribe: () => () => {},
          abort: () => {},
          dispose: () => {},
          prompt: async () => {
            prompts++;
            if (prompts === 1) {
              assert.ok(active.includes("search_traces"));
              await assert.rejects(
                submit.execute("early", finding, undefined, undefined, {} as never),
                /finalize_phase_required/,
              );
            } else {
              assert.deepEqual(active, ["submit_finding"]);
              await submit.execute("final", finding, undefined, undefined, {} as never);
            }
          },
        },
      };
    }) as unknown as typeof createAgentSession;
    const incident = {
      symptom: "latency",
      target: { service: "checkout" },
      window: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:10:00Z" },
      trigger: { type: "manual" as const },
    };
    try {
      const runner = new PiExpertRunner(
        {} as ModelRuntime,
        {} as ObservabilityToolRegistry,
        createSession,
      );
      const result = await runner.run({
        investigation: { id: "INV-paired", agentConfigVersion: version, hypotheses: [] } as never,
        task: { context: incident } as never,
        brief: {
          role: "trace",
          question: "test",
          hypothesisIds: [],
          context: { alertSummary: "test", mainWindow: incident.window, knownFacts: [] },
          expected: ["test"],
        },
        invoke: async () => {
          throw Error("no query expected");
        },
      });
      assert.equal(result.sessionId, "paired-expert");
      assert.equal(result.finding?.summary, "无可确认信号");
      assert.equal(prompts, 2);
    } finally {
      agentConfigStore.activate(TEST_CONFIG_VERSION, fixtureFiles());
    }
  },
);
