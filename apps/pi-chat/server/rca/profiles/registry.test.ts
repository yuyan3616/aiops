import assert from "node:assert/strict";
import test from "node:test";

import type { AgentExpertFinding, InvestigationBrief } from "../types";
import {
  buildExpertSystemPrompt,
  getExpertProfile,
  listExpertProfiles,
  normalizeFindingForProfile,
} from "./registry";

function brief(role: InvestigationBrief["role"], question: string): InvestigationBrief {
  return {
    role,
    question,
    hypothesisIds: ["H01"],
    context: {
      alertSummary: "checkout latency",
      service: "checkout",
      mainWindow: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      baselineWindow: {
        from: "2026-09-27T23:50:00.000Z",
        to: "2026-09-27T23:55:00.000Z",
      },
      knownFacts: [],
    },
    expected: ["test H01"],
  };
}

function finding(overrides: Partial<AgentExpertFinding> = {}): AgentExpertFinding {
  return {
    status: "succeeded",
    strength: "strong",
    verdict: "supports",
    summary: "finding",
    conclusions: ["answer"],
    evidenceClaims: [],
    candidateEntities: [],
    suggestedFollowUps: [],
    ...overrides,
  };
}

test("expert profile registry owns tools, modalities, and budgets", () => {
  const profiles = listExpertProfiles();
  assert.deepEqual(
    profiles.map((profile) => profile.role),
    ["trace", "metrics", "log", "event-topology"],
  );
  assert.deepEqual(getExpertProfile("trace").tools, ["search_traces", "get_trace"]);
  assert.deepEqual(getExpertProfile("metrics").modalities, ["metric"]);
  assert.equal(getExpertProfile("metrics").toolBudgets?.query_metrics, 6);
  assert.ok(profiles.every((profile) => profile.maxToolCalls === 12));
});

test("trace profile injects latency-gap skill only when relevant", () => {
  const withGap = buildExpertSystemPrompt(
    getExpertProfile("trace"),
    brief("trace", "Locate the unexplained 8s latency gap between frontend and checkout"),
  );
  assert.match(withGap, /\[latency-gap\]/);
  assert.match(withGap, /\[critical-path\]/);

  const ordinaryBrief = brief("trace", "Inspect checkout trace structure");
  ordinaryBrief.context.baselineWindow = undefined;
  const ordinary = buildExpertSystemPrompt(getExpertProfile("trace"), ordinaryBrief);
  assert.doesNotMatch(ordinary, /\[latency-gap\]/);
});

test("metrics and log profiles cap unsupported strong causal findings", () => {
  const metrics = normalizeFindingForProfile(
    getExpertProfile("metrics"),
    finding({
      evidenceClaims: [
        {
          toolCallId: "C01",
          modality: "metric",
          summary: "cpu increased",
          supports: ["H01"],
          contradicts: [],
        },
      ],
    }),
  );
  assert.equal(metrics.strength, "moderate");

  const log = normalizeFindingForProfile(
    getExpertProfile("log"),
    finding({
      evidenceClaims: [
        {
          toolCallId: "C02",
          modality: "log",
          summary: "timeout signature increased",
          supports: ["H01"],
          contradicts: [],
        },
      ],
    }),
  );
  assert.equal(log.strength, "moderate");
});

test("event-topology strong finding requires event plus topology evidence", () => {
  const profile = getExpertProfile("event-topology");
  const oneSided = normalizeFindingForProfile(
    profile,
    finding({
      evidenceClaims: [
        {
          toolCallId: "C01",
          modality: "event",
          summary: "deployment occurred",
          supports: ["H01"],
          contradicts: [],
        },
      ],
    }),
  );
  assert.equal(oneSided.strength, "moderate");

  const paired = normalizeFindingForProfile(
    profile,
    finding({
      evidenceClaims: [
        {
          toolCallId: "C01",
          modality: "event",
          summary: "deployment occurred before onset",
          supports: ["H01"],
          contradicts: [],
        },
        {
          toolCallId: "C02",
          modality: "topology",
          summary: "changed service is on the dependency path",
          supports: ["H01"],
          contradicts: [],
        },
      ],
    }),
  );
  assert.equal(paired.strength, "strong");
});
