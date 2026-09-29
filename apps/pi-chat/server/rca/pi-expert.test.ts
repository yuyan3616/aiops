import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { PiExpertRunner } from "./pi-expert";
import type {
  Investigation,
  InvestigationBrief,
  RcaTask,
} from "./types";
import type { ObservabilityToolRegistry } from "./tools";

type SessionFactoryOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type CreatedSession = Awaited<ReturnType<typeof createAgentSession>>;
type FakeEventListener = (event: unknown) => void;
type FakeTool = {
  name: string;
  execute: (
    toolCallId: string,
    parameters: Record<string, unknown>,
  ) => Promise<unknown>;
};

function fixture() {
  const investigation = {
    id: "INV-test",
    caseId: "t039",
    status: "running",
    symptom: "checkout latency",
    hypotheses: [
      {
        id: "H01",
        statement: "event/topology change is causal",
        status: "investigating",
        confidence: 0.4,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        nextChecks: [],
      },
    ],
  } as unknown as Investigation;

  const brief: InvestigationBrief = {
    role: "event-topology",
    question: "Check whether event/topology evidence supports H01.",
    hypothesisIds: ["H01"],
    context: {
      alertSummary: "checkout PlaceOrder latency increased",
      service: "checkout",
      mainWindow: {
        from: "2026-04-28T01:18:30.000Z",
        to: "2026-04-28T01:27:55.000Z",
      },
      knownFacts: [],
    },
    expected: ["Return a tool-backed finding."],
  };

  const task = {
    caseId: "t039",
    version: "runtime",
    alert: {
      eventId: "t039",
      title: "checkout PlaceOrder latency increased",
      triggerTime: "2026-04-28T01:27:55.000Z",
      window: brief.context.mainWindow,
      entity: {
        id: "checkout",
        name: "checkout",
        type: "service",
        domain: "otel-demo",
      },
      service: "checkout",
      operation: "PlaceOrder",
    },
    availableModalities: ["event", "topology", "alert"],
  } as RcaTask;

  return { investigation, brief, task };
}

function fakeRegistry(): ObservabilityToolRegistry {
  return {
    createPiTools(options: {
      names?: string[];
      execute?: (
        name: string,
        toolCallId: string,
        parameters: Record<string, unknown>,
      ) => Promise<unknown>;
    }) {
      return (options.names ?? []).map((name) => ({
        name,
        label: name,
        description: name,
        parameters: {},
        execute: (toolCallId: string, parameters: Record<string, unknown>) =>
          options.execute?.(name, toolCallId, parameters),
      }));
    },
  } as unknown as ObservabilityToolRegistry;
}

function successfulFinding(toolCallId?: string) {
  return {
    status: "succeeded",
    strength: toolCallId ? "moderate" : "inconclusive",
    verdict: toolCallId ? "supports" : "no-signal",
    summary: toolCallId
      ? "Event evidence supports H01 after bounded investigation."
      : "No additional event evidence was required.",
    conclusions: [toolCallId ? "The collected event signal is relevant." : "No signal."],
    evidenceClaims: toolCallId
      ? [
          {
            toolCallId,
            modality: "event",
            summary: "The recorded event query returned the relevant signal.",
            supports: ["H01"],
            contradicts: [],
          },
        ]
      : [],
    candidateEntities: toolCallId ? ["email-r2c9g"] : [],
    suggestedFollowUps: [],
  };
}

test("event-topology 工具调用满 12 次后在同一 Session 切换到 submit_finding", async () => {
  const sessionOptions: SessionFactoryOptions[] = [];
  const activeToolTransitions: string[][] = [];
  let activeTools: string[] = [];
  let promptCount = 0;

  const createSession = (async (
    options: SessionFactoryOptions,
  ): Promise<CreatedSession> => {
    sessionOptions.push(options);
    const listeners = new Set<FakeEventListener>();
    const tools = (options.customTools ?? []) as unknown as FakeTool[];
    const queryEvents = tools.find((item) => item.name === "query_events");
    const submitFinding = tools.find((item) => item.name === "submit_finding");
    assert.ok(queryEvents, "session should register query_events");
    assert.ok(submitFinding, "session should register submit_finding");

    const session = {
      sessionManager: {
        getSessionId: () => "single-expert-session",
      },
      setActiveToolsByName(names: string[]) {
        activeTools = [...names];
        activeToolTransitions.push([...names]);
      },
      subscribe(listener: FakeEventListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        promptCount += 1;
        assert.equal(promptCount, 1, "max-budget handoff should finish in the original run");
        assert.equal(activeTools.includes("query_events"), true);
        assert.equal(activeTools.includes("submit_finding"), false);

        for (let i = 0; i < 12; i++) {
          await queryEvents.execute("model-tool-" + (i + 1), {
            caseId: "t039",
            from: "2026-04-28T01:18:30.000Z",
            to: "2026-04-28T01:27:55.000Z",
            limit: 1,
          });
        }

        assert.deepEqual(activeTools, ["submit_finding"]);

        await assert.rejects(
          () =>
            submitFinding.execute("submit-invalid", {
              ...successfulFinding("C99"),
            }),
          /toolCallId/,
        );

        const submitted = (await submitFinding.execute(
          "submit-valid",
          successfulFinding("C12"),
        )) as { terminate?: boolean };
        assert.equal(submitted.terminate, true);
      },
      abort() {},
      dispose() {},
    };

    return { session } as unknown as CreatedSession;
  }) as typeof createAgentSession;

  const { investigation, brief, task } = fixture();
  let recorded = 0;
  const runner = new PiExpertRunner({} as ModelRuntime, fakeRegistry(), createSession);
  const result = await runner.run({
    investigation,
    task,
    brief,
    invoke: async () => {
      recorded += 1;
      return {
        callId: "C" + recorded,
        observationId: "O" + recorded,
        execution: {
          result: {
            caseId: "t039",
            modality: "event",
            matchedRows: 1,
            returnedRows: 1,
            data: { events: [{ id: recorded }] },
          },
          summary: "event query " + recorded,
          rawRef: "test://events/" + recorded,
        },
      };
    },
  });

  assert.equal(recorded, 12);
  assert.equal(result.diagnostics.toolCallCount, 12);
  assert.equal(result.diagnostics.repairAttempted, false);
  assert.equal(result.diagnostics.repairSucceeded, false);
  assert.equal(result.termination.reason, "completed");
  assert.equal(result.finding?.status, "succeeded");
  assert.equal(result.finding?.evidenceClaims[0]?.toolCallId, "C12");

  assert.equal(sessionOptions.length, 1);
  assert.equal(promptCount, 1);
  assert.deepEqual(activeToolTransitions.at(-1), ["submit_finding"]);
});

test("专家提前结束取证时仍在同一 Session 进入 Finalize Phase", async () => {
  const sessionOptions: SessionFactoryOptions[] = [];
  let activeTools: string[] = [];
  let promptCount = 0;

  const createSession = (async (
    options: SessionFactoryOptions,
  ): Promise<CreatedSession> => {
    sessionOptions.push(options);
    const listeners = new Set<FakeEventListener>();
    const tools = (options.customTools ?? []) as unknown as FakeTool[];
    const submitFinding = tools.find((item) => item.name === "submit_finding");
    assert.ok(submitFinding);

    const session = {
      sessionManager: {
        getSessionId: () => "single-expert-session",
      },
      setActiveToolsByName(names: string[]) {
        activeTools = [...names];
      },
      subscribe(listener: FakeEventListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        promptCount += 1;
        if (promptCount === 1) {
          assert.equal(activeTools.includes("submit_finding"), false);
          return;
        }
        assert.deepEqual(activeTools, ["submit_finding"]);
        await submitFinding.execute("submit-final", successfulFinding());
      },
      abort() {},
      dispose() {},
    };
    return { session } as unknown as CreatedSession;
  }) as typeof createAgentSession;

  const { investigation, brief, task } = fixture();
  const runner = new PiExpertRunner({} as ModelRuntime, fakeRegistry(), createSession);
  const result = await runner.run({
    investigation,
    task,
    brief,
    invoke: async () => {
      throw new Error("No investigation tool should be called");
    },
  });

  assert.equal(sessionOptions.length, 1);
  assert.equal(promptCount, 2);
  assert.equal(result.diagnostics.toolCallCount, 0);
  assert.equal(result.termination.reason, "completed");
  assert.equal(result.finding?.verdict, "no-signal");
});
