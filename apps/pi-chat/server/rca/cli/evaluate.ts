import { resolve } from "node:path";

import { RcaScorer } from "../evaluation/scorer";
import { InvestigationRepository } from "../repository";

const investigationId = process.argv[2];
if (!investigationId) throw new Error("Usage: rca:evaluate <investigation-id>");
const answerKeyDir = process.env.RCA100_ANSWER_KEY_DIR;
if (!answerKeyDir) throw new Error("RCA100_ANSWER_KEY_DIR is required only for evaluation");
const investigationsDir = resolve(process.env.RCA_INVESTIGATIONS_DIR ?? "data/rca/investigations");
const evaluation = await new RcaScorer(
  answerKeyDir,
  new InvestigationRepository(investigationsDir),
).evaluate(investigationId);
process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
