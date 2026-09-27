import { resolve } from "node:path";

import { RCA100Adapter } from "../adapter";
import { RcaOrchestrator } from "../orchestrator";
import { InvestigationRepository } from "../repository";
import { ObservabilityToolRegistry } from "../tools";

const caseId = process.argv[2] ?? "t039";
const casesDir = process.env.RCA100_CASES_DIR;
if (!casesDir) throw new Error("RCA100_CASES_DIR is required");
const investigationsDir = resolve(process.env.RCA_INVESTIGATIONS_DIR ?? "data/rca/investigations");
const repository = new InvestigationRepository(investigationsDir);
const orchestrator = new RcaOrchestrator(
  new ObservabilityToolRegistry(new RCA100Adapter(casesDir)),
  repository,
);
const { investigation } = await orchestrator.investigate({ caseId });
process.stdout.write(
  `${JSON.stringify(
    {
      investigationId: investigation.id,
      caseId,
      rounds: investigation.rounds,
      expertTasks: investigation.expertTasks.length,
      toolCalls: investigation.toolCalls.length,
      evidence: investigation.evidence.length,
      hypotheses: investigation.hypotheses.map(({ id, status, statement }) => ({
        id,
        status,
        statement,
      })),
      prediction: investigation.rootCause,
    },
    null,
    2,
  )}\n`,
);
