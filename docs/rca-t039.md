# RCA100 t039 investigation

Pi Chat contains an evidence-driven RCA path inside the normal Pi conversation runtime. Ask naturally, for example `帮我排查 t039 的根因` or `checkout 为什么突然变慢`. The Pi Main Agent decides when to start an investigation and drives the investigation through RCA tools; there is no separate deterministic RCA command path.

RCA business events are projected onto the existing Pi Chat stream protocol:

- real Pi model reasoning remains the native Thinking stream;
- hypotheses and specialist hand-offs are projected as structured RCA state / sub-agent events;
- observability queries appear as Tool cards with bounded result summaries;
- specialist Pi sessions expose their own thinking/tool/evidence lifecycle;
- completed investigations are persisted as immutable investigation artifacts and summarized by the Main Agent.

Raw references and full evidence remain in investigation artifacts instead of being dumped into the chat context.

## Fetching the real t039 telemetry

The repository does not vendor the RCA100 t039 Parquet payload directly. Instead it provides a reproducible downloader that fetches only the agent-facing case files and keeps Ground Truth outside the Agent runtime:

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

## Agentic investigation runtime

The production RCA path has one coordinator: the Pi Main Agent in the conversation session.

The Main Agent:

1. starts an investigation with `start_rca_investigation`;
2. queries bounded overview data when useful;
3. creates and updates falsifiable hypotheses;
4. dispatches Trace, Metrics, Log, and Event/Topology Pi specialist sessions with explicit briefs;
5. consumes specialist findings plus persisted Observations/Evidence;
6. accounts for every hypothesis as selected, rejected, or unresolved;
7. persists the final conclusion with `conclude_investigation`.

Specialists are real Pi sessions. They choose tools and parameters within server-side tool and resource limits. There is no `RcaOrchestrator`, deterministic specialist fallback, or separate RCA planner runtime.

A process restart marks an active investigation `interrupted` rather than permanently failed. The Main Agent can resume it or conclude from already persisted evidence when that evidence is sufficient.

## Investigation persistence and follow-up

The conversation record persists the active investigation id and the investigation ids associated with that conversation. Investigation artifacts persist:

- hypotheses and lifecycle state;
- tool-backed Observations;
- Evidence and raw references;
- specialist tasks, findings, and diagnostics;
- tool calls and resource snapshots;
- the final report.

Follow-up questions stay in the same Pi Main Agent conversation. The Main Agent reads the persisted investigation state with RCA tools instead of routing through a regex/template follow-up service. Existing investigation artifacts remain immutable unless the Main Agent explicitly resumes or starts a new investigation.

## Runtime boundaries

The agent runtime receives only the RCA case directory. `RCA100Adapter` loads task and telemetry files and exposes bounded query methods. The runtime RCA code does not import the evaluator and does not accept an answer-key directory.

Observability Parquet queries use bounded batch scans. Heavy scans are concurrency-limited, and large Metrics/Trace responses are compacted before entering model context while complete data remains traceable through `rawRef`.

Evaluation is a separate command and process. Only that command receives `RCA100_ANSWER_KEY_DIR`, and `RcaScorer` reads the answer key only after a completed prediction is present.

```text
Pi Main Agent
    |
    +-- RCA Main Agent tools
    |      |
    |      +-- bounded overview queries
    |      +-- hypothesis lifecycle
    |      +-- conclusion
    |
    +-- Pi specialist sessions
           |
           +-- Trace
           +-- Metrics
           +-- Log
           +-- Event / Topology
                  |
                  +-- observability tools
                          |
                          +-- RCA100Adapter
                                  |
                                  +-- Observation / Evidence / rawRef

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

- `RCA100Adapter`: schema discovery, bounded batch scans, filtering, aggregation and anomaly summaries.
- `ObservabilityToolRegistry`: the allow-listed alert, metric, log, trace, event and topology tools.
- `main-agent-tools.ts`: the Main Agent investigation controls for overview, hypotheses, specialist dispatch, state retrieval and conclusion.
- `PiExpertRunner`: creates Trace, Metrics, Log and Event/Topology Pi specialist sessions and validates their structured findings.
- `RcaService`: owns agentic investigation state, persistence, cancellation/resume, Observations, Evidence and conclusion validation.
- `InvestigationRepository`: persists `investigation.json`, `tool-calls.jsonl`, `events.jsonl`, `final-report.json` and, after scoring, `evaluation.json`.
- `RcaScorer`: evaluator-only code that reads Ground Truth after investigation completion.

## Run

Run Pi Chat normally and start RCA through the conversation:

```bash
cd apps/pi-chat
pnpm dev
```

Then ask the Main Agent to investigate `t039`. There is intentionally no standalone `rca:run` deterministic execution path.

Evaluation remains separate:

```bash
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
