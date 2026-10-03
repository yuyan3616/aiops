import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { InvestigationRepository } from "../repository";
import type { Investigation, InvestigationEvent } from "../types";

interface GroundTruthFile {
  root_cause_entities?: string[];
  root_cause_types?: string[];
  raw_ground_truth?: string;
  [key: string]: unknown;
}

interface RawGroundTruth {
  outcome?: {
    expected_fault_id?: string;
    expected_conclusion?: string;
    target_entities?: Array<{ entity_name?: string }>;
  };
}

export interface EvaluationDimension {
  score: number;
  matched: boolean;
  explanation: string;
}

export interface RcaEvaluation {
  investigationId: string;
  caseId: string;
  evaluatedAt: string;
  overallScore: number;
  passed: boolean;
  rootCauseEntity: EvaluationDimension & {
    predicted: string[];
    expected: string[];
  };
  faultMechanism: EvaluationDimension & {
    predicted?: string;
    expected: string[];
  };
  evidenceQuality: EvaluationDimension & {
    evidenceIds: string[];
    modalities: string[];
  };
  reasoningTrace: EvaluationDimension & {
    observedStages: string[];
  };
  groundTruthSummary?: string;
}

function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !["probable", "affecting", "exact"].includes(word));
}

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Deliberately lives outside the runtime/tool graph. Only this evaluator is
 * allowed to receive an answer-key directory, and it requires a completed
 * persisted prediction before opening that directory.
 */
export class RcaScorer {
  private readonly answerKeyDir: string;
  private readonly repository: InvestigationRepository;

  constructor(answerKeyDir: string, repository: InvestigationRepository) {
    this.answerKeyDir = resolve(answerKeyDir);
    this.repository = repository;
  }

  async evaluate(investigationId: string): Promise<RcaEvaluation> {
    const investigation = await this.repository.get(investigationId);
    if (!investigation.completedAt || !investigation.rootCause) {
      throw new Error("Ground truth cannot be read before an investigation is completed");
    }
    const caseId = investigation.caseId;
    if (!caseId) {
      throw new Error("RCA100 offline scorer only supports legacy investigations with caseId");
    }
    const truth = JSON.parse(
      await readFile(join(this.answerKeyDir, `${caseId}.gt.json`), "utf8"),
    ) as GroundTruthFile;
    const rawTruth = truth.raw_ground_truth
      ? (JSON.parse(truth.raw_ground_truth) as RawGroundTruth)
      : undefined;
    const expectedEntities = [
      ...(truth.root_cause_entities ?? []),
      ...(rawTruth?.outcome?.target_entities?.flatMap((item) =>
        item.entity_name ? [item.entity_name] : [],
      ) ?? []),
    ].filter((value, index, all) => all.indexOf(value) === index);
    const predictedEntities = investigation.rootCause.rootCauseEntities;
    const entityMatched = expectedEntities.some((expected) =>
      predictedEntities.some((predicted) => {
        const normalizedExpected = normalizeEntity(expected);
        const normalizedPredicted = normalizeEntity(predicted);
        return (
          normalizedPredicted === normalizedExpected ||
          normalizedPredicted.startsWith(normalizedExpected)
        );
      }),
    );

    const expectedMechanisms = truth.root_cause_types ?? [];
    const predictedMechanism = investigation.rootCause.mechanism;
    const predictedWords = new Set(words(predictedMechanism ?? ""));
    const mechanismMatched = expectedMechanisms.some((expected) => {
      const expectedWords = words(expected);
      return expectedWords.length > 0 && expectedWords.every((word) => predictedWords.has(word));
    });

    const evidence = investigation.evidence.filter((item) =>
      investigation.rootCause!.evidenceIds.includes(item.id),
    );
    const completedCallIds = new Set(
      investigation.toolCalls.filter((call) => call.status === "completed").map((call) => call.id),
    );
    const traceableEvidence = evidence.filter(
      (item) =>
        item.caseId === caseId &&
        item.rawRef.startsWith(`rca100://${caseId}/`) &&
        Object.keys(item.sourceQuery).length > 0 &&
        completedCallIds.has(item.toolCallId),
    );
    const modalities = [...new Set(traceableEvidence.map((item) => item.modality))];
    const evidenceScore =
      evidence.length === 0
        ? 0
        : 0.5 * (traceableEvidence.length / evidence.length) +
          0.5 * Math.min(1, modalities.length / 2);

    const eventPath = join(this.repository.directory(investigationId), "events.jsonl");
    const events = parseJsonLines<InvestigationEvent>(await readFile(eventPath, "utf8"));
    const stages = this.reasoningStages(investigation, events);
    const reasoningScore = stages.length / 5;
    const entityScore = entityMatched ? 1 : 0;
    const mechanismScore = mechanismMatched ? 1 : 0;
    const overallScore = Number(
      (
        entityScore * 0.4 +
        mechanismScore * 0.25 +
        evidenceScore * 0.2 +
        reasoningScore * 0.15
      ).toFixed(3),
    );
    const evaluation: RcaEvaluation = {
      investigationId,
      caseId: caseId,
      evaluatedAt: new Date().toISOString(),
      overallScore,
      passed: entityMatched && mechanismMatched && evidenceScore >= 0.8 && reasoningScore === 1,
      rootCauseEntity: {
        score: entityScore,
        matched: entityMatched,
        predicted: predictedEntities,
        expected: expectedEntities,
        explanation: entityMatched
          ? "At least one predicted root-cause entity matches the answer key."
          : "No predicted root-cause entity matches the answer key.",
      },
      faultMechanism: {
        score: mechanismScore,
        matched: mechanismMatched,
        predicted: predictedMechanism,
        expected: expectedMechanisms,
        explanation: mechanismMatched
          ? "The predicted mechanism contains the discriminating answer-key mechanism terms."
          : "The predicted mechanism does not identify the answer-key fault type.",
      },
      evidenceQuality: {
        score: Number(evidenceScore.toFixed(3)),
        matched: evidenceScore >= 0.8,
        evidenceIds: evidence.map((item) => item.id),
        modalities,
        explanation: `${traceableEvidence.length}/${evidence.length} conclusion evidence items are query-traceable across ${modalities.length} modalities.`,
      },
      reasoningTrace: {
        score: Number(reasoningScore.toFixed(3)),
        matched: reasoningScore === 1,
        observedStages: stages,
        explanation: `Observed ${stages.length}/5 required reasoning stages in the persisted event and tool-call trail.`,
      },
      groundTruthSummary: rawTruth?.outcome?.expected_conclusion,
    };
    await this.repository.saveEvaluation(investigationId, evaluation);
    return evaluation;
  }

  private reasoningStages(investigation: Investigation, events: InvestigationEvent[]): string[] {
    const stages: string[] = [];
    if (events.some((event) => event.type === "hypothesis.created")) stages.push("hypothesis");
    if (investigation.toolCalls.some((call) => call.expertTaskId && call.status === "completed")) {
      stages.push("query");
    }
    if (events.some((event) => event.type === "evidence.created")) stages.push("evidence");
    if (
      events.some(
        (event) =>
          event.type === "hypothesis.updated" &&
          ["supported", "confirmed", "rejected"].includes(String(event.payload.current)),
      )
    ) {
      stages.push("hypothesis-update");
    }
    if (events.some((event) => event.type === "investigation.completed")) {
      stages.push("conclusion");
    }
    return stages;
  }
}
