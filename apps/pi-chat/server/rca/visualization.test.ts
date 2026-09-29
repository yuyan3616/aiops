import assert from "node:assert/strict";
import test from "node:test";

import type { Investigation, InvestigationEvent } from "./types";
import { buildInvestigationFlow } from "./visualization/builder";
import { compileMermaidFlow } from "./visualization/mermaid";

function fixture(): Investigation {
  return {
    id: "INV-20260928071227-53e9e4f9",
    caseId: "t039",
    status: "completed",
    symptom: "checkout PlaceOrder response time increased",
    alertContext: {
      eventId: "t039",
      title: "checkout PlaceOrder 响应时间突增",
      triggerTime: "2026-09-28T01:27:55.000Z",
      window: {
        from: "2026-09-28T01:18:30.000Z",
        to: "2026-09-28T01:27:55.000Z",
      },
      entity: {
        id: "checkout",
        name: "checkout",
        type: "service",
        domain: "otel-demo",
      },
      service: "checkout",
      operation: "PlaceOrder",
    },
    scope: {
      alertService: "checkout",
      alertOperation: "PlaceOrder",
      timeRange: {
        from: "2026-09-28T01:18:30.000Z",
        to: "2026-09-28T01:27:55.000Z",
      },
      candidateEntities: ["checkout", "email"],
    },
    hypotheses: [
      {
        id: "H01",
        statement: "email 服务自身处理链路劣化",
        status: "supported",
        confidence: 0.75,
        supportingEvidenceIds: ["E09"],
        contradictingEvidenceIds: [],
        nextChecks: [],
      },
      {
        id: "H02",
        statement: "checkout 客户端侧阻塞",
        status: "rejected",
        confidence: 0.9,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: ["E16"],
        nextChecks: [],
      },
      {
        id: "H03",
        statement: "故障起点早于告警窗口",
        status: "supported",
        confidence: 0.85,
        supportingEvidenceIds: ["E07"],
        contradictingEvidenceIds: [],
        nextChecks: [],
      },
    ],
    observations: [],
    evidence: [],
    expertTasks: [
      {
        id: "T01",
        expert: "trace",
        objective: "验证 H01/H02",
        status: "failed",
        hypothesisIds: ["H01", "H02"],
        toolCallIds: [],
        evidenceIds: [],
        implementation: "pi-session",
        budgetClass: "primary",
        dispatchOperationId: "round-1",
        createdAt: "2026-09-28T01:20:00.000Z",
        completedAt: "2026-09-28T01:20:20.000Z",
      },
      {
        id: "T02",
        expert: "metrics",
        objective: "验证 H01/H02/H03",
        status: "completed",
        hypothesisIds: ["H01", "H02", "H03"],
        toolCallIds: [],
        evidenceIds: ["E03", "E04", "E05", "E06", "E07"],
        implementation: "pi-session",
        budgetClass: "primary",
        dispatchOperationId: "round-1",
        finding: {
          status: "succeeded",
          strength: "moderate",
          summary: "强支持 H03，中支持 H01",
          conclusions: [],
          evidenceClaims: [],
          candidateEntities: [],
          suggestedFollowUps: [],
        },
        createdAt: "2026-09-28T01:20:00.000Z",
        completedAt: "2026-09-28T01:20:25.000Z",
      },
      {
        id: "T03",
        expert: "log",
        objective: "验证 H01/H02/H03",
        status: "failed",
        hypothesisIds: ["H01", "H02", "H03"],
        toolCallIds: [],
        evidenceIds: [],
        implementation: "pi-session",
        budgetClass: "primary",
        dispatchOperationId: "round-1",
        createdAt: "2026-09-28T01:20:00.000Z",
        completedAt: "2026-09-28T01:20:21.000Z",
      },
      {
        id: "T04",
        expert: "trace",
        objective: "只回答 gap 能否归因 email",
        status: "completed",
        hypothesisIds: ["H01", "H02"],
        toolCallIds: [],
        evidenceIds: ["E15", "E16", "E17", "E18", "E20"],
        implementation: "pi-session",
        budgetClass: "recovery",
        recoveryOfTaskId: "T01",
        dispatchOperationId: "round-2",
        finding: {
          status: "succeeded",
          strength: "moderate",
          summary: "gap 无 span 覆盖，tracing 无法单独区分 H01/H02",
          conclusions: [],
          evidenceClaims: [],
          candidateEntities: [],
          suggestedFollowUps: [],
        },
        createdAt: "2026-09-28T01:22:00.000Z",
        completedAt: "2026-09-28T01:22:18.000Z",
      },
      {
        id: "T05",
        expert: "log",
        objective: "只回答 r2c9g 日志能否证明阻塞",
        status: "completed",
        hypothesisIds: ["H01"],
        toolCallIds: [],
        evidenceIds: ["E09", "E10", "E11", "E12", "E13", "E14"],
        implementation: "pi-session",
        budgetClass: "recovery",
        recoveryOfTaskId: "T03",
        dispatchOperationId: "round-2",
        finding: {
          status: "succeeded",
          strength: "strong",
          summary: "r2c9g 明显慢于 peer，支持 H01",
          conclusions: [],
          evidenceClaims: [],
          candidateEntities: ["email-7f697b9b59-r2c9g"],
          suggestedFollowUps: [],
        },
        createdAt: "2026-09-28T01:22:00.000Z",
        completedAt: "2026-09-28T01:22:19.000Z",
      },
    ],
    toolCalls: [
      {
        id: "C01",
        tool: "get_alert_context",
        query: { caseId: "t039" },
        status: "completed",
        startedAt: "2026-09-28T01:18:30.000Z",
        completedAt: "2026-09-28T01:18:31.000Z",
      },
    ],
    rootCause: {
      investigationId: "INV-20260928071227-53e9e4f9",
      status: "probable",
      rootCauseEntities: ["email-7f697b9b59-r2c9g"],
      summary: "email pod r2c9g 处理链路劣化，且故障起点早于告警窗口",
      evidenceIds: ["E09", "E16"],
      rejectedHypotheses: ["H02"],
      selectedHypothesisIds: ["H01", "H03"],
      unresolvedHypotheses: [],
      confidence: 0.75,
    },
    rounds: 2,
    startedAt: "2026-09-28T01:18:30.000Z",
    completedAt: "2026-09-28T01:23:00.000Z",
  };
}

test("整体流程投影保留中断、恢复、Recovery 与根因收敛", () => {
  const events: InvestigationEvent[] = [
    {
      id: 1,
      investigationId: "INV-20260928071227-53e9e4f9",
      type: "investigation.resumed",
      at: "2026-09-28T01:21:50.000Z",
      summary: "resumed",
      payload: {},
    },
  ];
  const flow = buildInvestigationFlow(fixture(), events);
  const ids = new Set(flow.nodes.map((node) => node.id));

  assert.equal(ids.has("interruption-1"), true);
  assert.equal(ids.has("resume-1"), true);
  assert.equal(ids.has("dispatch-2"), true);
  assert.equal(ids.has("task-T04"), true);
  assert.equal(ids.has("task-T05"), true);
  assert.equal(ids.has("hypothesis-final-H02"), true);
  assert.equal(ids.has("root-cause"), true);

  const mermaid = compileMermaidFlow(flow);
  assert.match(mermaid, /^flowchart TD/m);
  assert.match(mermaid, /Recovery Dispatch/);
  assert.match(mermaid, /email-7f697b9b59-r2c9g/);
  assert.match(mermaid, /classDef failed/);
});
