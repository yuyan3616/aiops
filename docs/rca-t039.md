# RCA100 t039 investigation

Pi Chat now contains an evidence-driven RCA path that preserves its existing session, SSE architecture, and chat UI. Enter `/rca t039`, or send a natural incident-investigation request such as `帮我排查 checkout 响应时间突然升高的问题`. The default case is configured with `RCA_DEFAULT_CASE_ID`.

RCA business events are projected onto the original Pi Chat stream protocol:

- investigation decisions, hypotheses, evidence, and expert hand-offs → existing Thinking blocks;
- real observability queries → existing Tool cards with bounded result summaries;
- completed investigation → existing Assistant Markdown message.

There is no RCA dashboard or RCA-specific frontend component. Raw references and full evidence remain in the investigation artifacts rather than being dumped into the chat.

## Fetching the real t039 telemetry

The repository does not vendor the 32 MB RCA100 t039 Parquet payload directly. Instead it provides a reproducible downloader that fetches only the agent-facing case files and keeps Ground Truth outside the Agent runtime:

```bash
cd apps/pi-chat
pnpm rca:fetch:t039
```

This writes the case to:

```
apps/pi-chat/.rca-data/cases/t039/
```

and preserves the upstream RCA100 license at `apps/pi-chat/.rca-data/RCA100-LICENSE`. The `.rca-data/` directory is gitignored so large benchmark binaries do not bloat normal source-code commits.

To run Pi Chat against that data, set:

```bash
RCA100_CASES_DIR=$PWD/.rca-data/cases
```

The downloader intentionally does not fetch `RCA100/answer_key`; Ground Truth remains evaluator-only.

## Agentic coordinator and chat-history persistence

The production Pi Chat server now uses a Pi-backed RCA coordinator planner by default. The planner chooses the next specialist from the current hypotheses and Evidence; guarded server-side rules still validate Evidence and the final conclusion. Set `RCA_AGENTIC_PLANNER=false` to use the deterministic fallback planner for offline or reproducible runs.

If the planner model is unavailable, returns malformed output, or is not authenticated, the runtime automatically falls back to the deterministic planner rather than failing the investigation.

RCA chat projections are persisted in the conversation record. User messages, investigation summaries, Tool cards, Evidence/Hypothesis reasoning summaries, follow-up explanations, and the final RCA answer are merged with the native Pi Session transcript by chronological sequence. Refreshing the browser or restarting the server therefore restores the same chat-first RCA history instead of relying only on the in-memory SSE channel.

When traces cannot localize a downstream candidate, the investigation no longer aborts or dead-ends. Metrics, logs, and event/topology experts can continue against the alerted service itself. A local-service conclusion still requires at least two independent supporting modalities; otherwise the result remains `inconclusive`.

## Investigation follow-up

The conversation record persists the most recent `activeInvestigationId` and all investigation IDs started in that session. After RCA completes, natural follow-up questions stay in the same Pi Chat conversation and read the complete immutable investigation artifact:

- root cause and confidence;
- current hypotheses plus status history from `events.jsonl`;
- evidence, source queries, time ranges, entities, and raw references;
- expert tasks and their actual tool calls.

Explanatory follow-ups do not query telemetry again. Evidence drill-down and counterfactual answers are read-only; they never rewrite the original hypothesis state or result. A request that explicitly asks to re-run or re-check starts a new investigation and makes it the active investigation for subsequent questions.

## Runtime boundaries

The runtime is constructed with only `RCA100_CASES_DIR` and can access only `cases/<caseId>`. `RCA100Adapter` loads task and telemetry files and exposes bounded query methods. Neither the adapter, the orchestrator, the expert agents, nor their tool registry imports the evaluator or accepts an answer-key directory.

Evaluation is a separate command and process. Only that command receives `RCA100_ANSWER_KEY_DIR`, and `RcaScorer` refuses to open the answer key until a completed prediction is present in `investigation.json`.

```text
task alert -> orchestrator -> expert task -> observability tool -> RCA100Adapter
                ^                                      |
                |--------- evidence + hypothesis ------|

completed prediction -> independent scorer <- answer key
```

## Actual t039 files and schemas

The adapter reads the schema from the files rather than assuming it from their names.

| File              |                     Rows | Fields                                                                                                        |
| ----------------- | -----------------------: | ------------------------------------------------------------------------------------------------------------- |
| `task.json`       |                        1 | alert, alert window, entity, service, operation, workspace, region                                            |
| `metrics.parquet` |                   91,162 | `time`, `domain`, `entity_set`, `entity_id`, `entity_name`, `metric`, `value`, `metric_set_id`, `service`     |
| `logs.parquet`    |                  616,778 | 15 fields including `content`, `_time_`, `_container_name_`, `_pod_name_`, node and cluster tags              |
| `traces.parquet`  |                  447,541 | 21 fields including trace/span IDs, parent, name, start/end/duration, service, host, status and attributes    |
| `events.parquet`  |                      450 | `eventId`, `hostname`, `level`, `pod_id`, `pod_name`, cluster fields and topic                                |
| `alerts.parquet`  |                       12 | 20 CloudEvents-style alert fields including `time`, `subject`, `severity`, `labels`, `annotations` and `data` |
| `topology.json`   | 297 entities + 389 edges | entity records and directed dependency edges                                                                  |

The initial alert is loaded from `task.json`. It is not duplicated in a prompt or source-code branch.

## Components

- `RCA100Adapter`: discovers schemas and performs time/entity filtering, aggregation, anomaly summaries, top-N selection and sampling.
- `ObservabilityToolRegistry`: registers alert, metric, log, trace, event, alert and topology tools for both the orchestrator and Pi runtime.
- Expert agents: Trace, Metrics, Log and Event/Topology experts return evidence rather than free-form inter-agent chat.
- `RcaOrchestrator`: maintains investigation state, hypotheses and the dynamic next-check loop.
- `InvestigationRepository`: persists `investigation.json`, `tool-calls.jsonl`, `events.jsonl`, `final-report.json` and, after scoring, `evaluation.json`.
- `RcaScorer`: reads the answer key only after completion and scores entity, mechanism, evidence quality and reasoning trace.

## Run

```bash
cd apps/pi-chat

RCA100_CASES_DIR=/absolute/path/to/RCA100/cases \
RCA_INVESTIGATIONS_DIR=./data/rca/investigations \
pnpm rca:run t039

RCA100_ANSWER_KEY_DIR=/absolute/path/to/RCA100/answer_key \
RCA_INVESTIGATIONS_DIR=./data/rca/investigations \
pnpm rca:evaluate INV-...
```

Do not set `RCA100_ANSWER_KEY_DIR` on the agent runtime. It is intentionally consumed only by the evaluator CLI.

## Verify

```bash
pnpm --filter pi-chat test
pnpm --filter pi-chat typecheck
pnpm --filter pi-chat lint
pnpm --filter pi-chat build
```
