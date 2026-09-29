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

type SessionFactoryOptions = Parameters<typeof createAgentSession>[0];
type CreatedSession = Awaited<ReturnType<typeof createAgentSession>>;
type FakeEventListener = (event: unknown) => void;

function fakeSession(
  id: string,
  runPrompt: (
    prompt: string,
    emit: (event: unknown) => void,
  ) => Promise<void>,
): CreatedSession["session"] {
  const listeners = new Set<FakeEventListener>();
  const session = {
    sessionManager: {
      getSessionId: () => id,
    },
    subscribe(listener: FakeEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(prompt: string) {
      await runPrompt(prompt, (event) => {
        for (const listener of listeners) listener(event);
      });
    },
    abort() {},
    dispose() {},
  };
  return session as unknown as CreatedSession["session"];
}

test("event-topology 工具调用满 12 次后使用 no-tools Finalize 并返回 finding", async () => {
  const sessionOptions: SessionFactoryOptions[] = [];
  let sessionNumber = 0;

  const createSession = (async (
    options: SessionFactoryOptions,
  ): Promise<CreatedSession> => {
    sessionOptions.push(options);
    sessionNumber += 1;

    if (sessionNumber === 1) {
      return {
        session: fakeSession("investigation-session", async (_prompt) => {
          const tool = (options.customTools ?? []).find(
            (item) => item.name === "query_events",
          );
          assert.ok(tool, "investigation session should expose query_events");

          for (let i = 0; i < 12; i++) {
            await tool.execute("model-tool-" + (i + 1), {
              caseId: "t039",
              from: "2026-04-28T01:18:30.000Z",
              to: "2026-04-28T01:27:55.000Z",
              limit: 1,
            });
          }

          // Deliberately emit no text_delta. This reproduces the old failure:
          // the expert used its whole tool budget but did not submit JSON.
        }),
      } as CreatedSession;
    }

    return {
      session: fakeSession("finalize-session", async (_prompt, emit) => {
        emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: JSON.stringify({
              status: "succeeded",
              strength: "moderate",
              verdict: "supports",
              summary: "Event evidence supports H01 after bounded investigation.",
              conclusions: ["The collected event signal is relevant."],
              evidenceClaims: [
                {
                  toolCallId: "C12",
                  modality: "event",
                  summary: "The twelfth recorded event query returned the relevant signal.",
                  supports: ["H01"],
                  contradicts: [],
                },
              ],
              candidateEntities: ["email-r2c9g"],
              suggestedFollowUps: [],
            }),
          },
        });
      }),
    } as CreatedSession;
  }) as typeof createAgentSession;

  const tools = {
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
        execute: (toolCallId: string, parameters: Record<string, unknown>) =>
          options.execute?.(name, toolCallId, parameters),
      }));
    },
  } as unknown as ObservabilityToolRegistry;

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

  let recorded = 0;
  const runner = new PiExpertRunner(
    {} as ModelRuntime,
    tools,
    createSession,
  );
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
  assert.equal(result.diagnostics.repairAttempted, true);
  assert.equal(result.diagnostics.repairSucceeded, true);
  assert.equal(result.termination.reason, "completed");
  assert.equal(result.finding?.status, "succeeded");
  assert.equal(result.finding?.evidenceClaims[0]?.toolCallId, "C12");

  assert.equal(sessionOptions.length, 2);
  assert.ok((sessionOptions[0]?.tools?.length ?? 0) > 0);
  assert.equal(sessionOptions[1]?.tools?.length ?? 0, 0);
  assert.equal(sessionOptions[1]?.customTools?.length ?? 0, 0);
});
