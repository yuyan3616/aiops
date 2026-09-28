import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationRcaContextFromInvestigation,
  decideStartRcaInvestigation,
  idleConversationRcaContext,
  renderConversationRcaContext,
  unavailableConversationRcaContext,
} from "./conversation-context";
import type { Investigation, InvestigationStatus } from "./types";

function investigation(status: InvestigationStatus): Investigation {
  return {
    id: "INV-context",
    caseId: "t039",
    status,
    symptom: "checkout latency",
    alertContext: {
      eventId: "evt",
      title: "checkout latency",
      triggerTime: "2026-09-28T00:00:00.000Z",
      window: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      entity: {
        id: "checkout",
        name: "checkout",
        type: "service",
        domain: "app",
      },
    },
    scope: {
      timeRange: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      candidateEntities: ["checkout"],
    },
    hypotheses: [],
    observations: [],
    evidence: [],
    expertTasks: [],
    toolCalls: [],
    rounds: 2,
    startedAt: "2026-09-28T00:00:00.000Z",
  };
}

test("renders a compact server-authoritative RCA context", () => {
  const active = conversationRcaContextFromInvestigation(investigation("interrupted"));
  const rendered = renderConversationRcaContext(active);

  assert.equal(active.investigationId, "INV-context");
  assert.equal(active.caseId, "t039");
  assert.match(rendered, /server-authoritative/);
  assert.match(rendered, /state: interrupted/);
  assert.match(rendered, /active investigation: INV-context/);
  assert.match(rendered, /resume/i);

  const withIntervention = investigation("running");
  withIntervention.userInterventions = [
    {
      id: "UI01",
      content: "14:02 checkout 做过一次手工发布",
      createdAt: "2026-09-28T00:02:00.000Z",
    },
  ];
  const interventionContext = conversationRcaContextFromInvestigation(withIntervention);
  const interventionRendered = renderConversationRcaContext(interventionContext);
  assert.match(interventionRendered, /调查中用户补充/);
  assert.match(interventionRendered, /UI01/);
  assert.match(interventionRendered, /14:02 checkout/);
  assert.match(interventionRendered, /不是 telemetry evidence/);

  const idle = renderConversationRcaContext(idleConversationRcaContext());
  assert.match(idle, /state: idle/);
  assert.match(idle, /active investigation: none/);
});

test("prevents accidental replacement of a linked investigation", () => {
  assert.equal(
    decideStartRcaInvestigation(idleConversationRcaContext(), "t039", false).allowed,
    true,
  );

  const completed = conversationRcaContextFromInvestigation(investigation("completed"));
  const blocked = decideStartRcaInvestigation(completed, "t039", false);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.recommendedAction, "read_active_investigation");

  const explicitRerun = decideStartRcaInvestigation(completed, "t039", true);
  assert.equal(explicitRerun.allowed, true);

  const running = conversationRcaContextFromInvestigation(investigation("running"));
  const forcedWhileRunning = decideStartRcaInvestigation(running, "t040", true);
  assert.equal(forcedWhileRunning.allowed, false);
  assert.equal(forcedWhileRunning.recommendedAction, "continue_active_investigation");

  const unavailable = decideStartRcaInvestigation(
    unavailableConversationRcaContext("INV-missing"),
    "t039",
    false,
  );
  assert.equal(unavailable.allowed, false);
  assert.equal(
    unavailable.recommendedAction,
    "explicit_new_investigation_required",
  );
});
