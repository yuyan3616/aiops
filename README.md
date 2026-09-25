# Pi Chat RCA — v8.1 Controlled Harness

A chat-first multi-agent RCA system built on Pi `0.86.1`. v8.0 replaced hard-coded observability answers with real queries over the public RCA100 v1.1 `t039` telemetry. v8.1 keeps that real-data loop and adds a **Controlled Investigation Harness** around Pi AgentSession so specialist work is bounded, cancellable, context-controlled and traceable.

Current demo baseline:

- Dataset: RCA100 v1.1
- Case: `t039`
- Alert: `checkout响应时间突增告警`
- Modalities: metrics, logs, traces, Kubernetes events, alerts, topology
- LLM/agents: real Pi AgentSession
- Data access: real DuckDB queries over Parquet/JSON
- Harness: AgentTask + TaskScheduler + ContextBuilder + BudgetGuard + ToolGuard + cancellation
- Ground truth: **not downloaded and not exposed to agents**

## Architecture

```text
RCA100 task.json
      |
      v
Pi Coordinator AgentSession
      |
      | delegate_agents(assignments)
      v
InvestigationHarness
      |
      +--> AgentTask / TaskPolicy
      +--> TaskScheduler
      |      - same Agent kind: concurrency 1
      |      - global specialist concurrency: 3 by default
      +--> ContextBuilder
      |      - case metadata
      |      - assignment
      |      - selected hypotheses / Evidence
      |      - no cross-Agent transcript sharing
      v
AgentManager
      |
      +----------------+----------------+----------------+
      |                |                |                |
      v                v                v                v
 Log Session      Metric Session    Trace Session    Context Session
      |                |                |                |
      +----------------+--------+-------+----------------+
                               |
                        BudgetGuard
                               |
                         ToolGuard
                               |
                      RCA Tool Gateway
                               |
                        Evidence Store
                               |
                      RCA100 Repository
                               |
                  +------------+-------------+
                  |                          |
                  v                          v
              DuckDB                      JSON
        logs/metrics/traces/         task/topology
          events/alerts
```

Pi still owns the LLM loop, model/provider integration, one AgentSession's transcript, provider retry and tool-calling protocol. The RCA Harness owns task lifecycle, scheduling, cross-Agent context assembly, hard budgets, cancellation and investigation-level correlation metadata.

## v8.1 Harness behavior

Each specialist invocation becomes a first-class `AgentTask` before it starts:

```text
queued -> running -> succeeded
                \-> failed
                \-> timed_out
queued/running  \-> cancelled
```

Default policy:

```text
timeout       60s
maxTurns       6
maxToolCalls  10
maxEvidence   12
maxAttempts    1
```

The defaults are centralized and can be overridden through `.env`:

```env
RCA_TASK_TIMEOUT_MS=60000
RCA_TASK_MAX_TURNS=6
RCA_TASK_MAX_TOOL_CALLS=10
RCA_TASK_MAX_EVIDENCE=12
RCA_TASK_GLOBAL_CONCURRENCY=3
```

The scheduler guarantees that one persistent Specialist AgentSession never receives two simultaneous prompts. Different specialist roles may still run concurrently when the global slot limit permits.

## Context boundary

Specialist Agents do not receive the Coordinator transcript or other Agents' full transcripts. `ContextBuilder` constructs a bounded task context from:

- RCA100 case metadata and incident window;
- the current assignment;
- explicitly referenced hypotheses/Evidence;
- bounded relevant/recent Evidence;
- current TaskPolicy constraints.

Agent-to-Agent knowledge sharing therefore happens through structured Evidence/Hypothesis state rather than transcript copying.

## Cancellation and guardrails

`POST /api/rca/incidents/:id/abort` propagates cancellation from the investigation to queued/running tasks and then to the Pi Specialist Session via `session.abort()`.

`ToolGuard` is independent of the model schema and enforces:

- Agent -> tool ACL;
- string/array/request limits;
- incident-window time-range validation;
- result row/string/serialized-size bounds;
- Evidence shape checks;
- opaque `rca100://...` raw references;
- no answer-key or backend filesystem path leakage.

Tool output remains factual. Neither ToolGuard nor ToolGateway is allowed to infer the root cause.

## Skill vs Tool

`apps/pi-chat/skills/rca-investigation/SKILL.md` contains the Coordinator's RCA methodology:

- distinguish root cause / propagation / impact;
- treat the alert entity as a starting point, not the answer;
- use multiple modalities;
- explicitly support/reject hypotheses;
- stop only when the evidence chain closes.

The Skill teaches *how to investigate*. Tools perform concrete data access. Specialist Pi sessions use role-specific system prompts plus a strict custom-tool surface; generic coding tools remain disabled.

## Run locally

### 1. Requirements

Use Node.js **22.19.0 or newer**.

```bash
node -v
```

### 2. Configure a model

```bash
cd apps/pi-chat
cp .env.example .env
```

Configure at least one Pi-supported provider key, for example:

```env
OPENAI_API_KEY=...
# or ANTHROPIC_API_KEY=...
# or GEMINI_API_KEY=...
```

Optionally pin a model:

```env
RCA_MODEL_PROVIDER=openai
RCA_MODEL_ID=<model-id-registered-in-pi>
```

Both model variables must be configured together. Leave both unset to let Pi choose an authenticated model.

### 3. Install

```bash
npm install
```

The three Pi packages are pinned exactly to `0.86.1`. DuckDB Node API is pinned for the RCA100 query engine.

### 4. Prepare `t039`

The runtime defaults to:

```env
RCA100_AUTO_DOWNLOAD=true
```

so the first demo can download the seven public case files into:

```text
apps/pi-chat/data/rca100/cases/t039/
```

You can prefetch and smoke-test explicitly:

```bash
npm run rca100:download -- --case t039
npm run rca100:smoke -- --case t039
```

The downloader validates JSON and Parquet `PAR1` boundaries. The smoke command uses the same DuckDB Node runtime as the application to open the five Parquet modalities and print row counts/schema.

### 5. Run Harness tests

```bash
npm run harness:test
```

The deterministic suite covers same-Agent serialization, cross-Agent concurrency, global concurrency, context bounding, tool/turn/Evidence budgets, ToolGuard, timeout, cancellation and task-event correlation.

### 6. Start

```bash
npm run dev
```

Choose **RCA100 · t039** from “为你推荐” and click **一键运行**.

Expected runtime path:

```text
prepare t039 telemetry
        ↓
Pi Coordinator
        ↓
delegate_agents
        ↓
AgentTask + TaskScheduler
        ↓
ContextBuilder
        ↓
bounded Specialist AgentSession
        ↓
BudgetGuard / ToolGuard
        ↓
real DuckDB RCA100 query
        ↓
Evidence EVxx
        ↓
hypothesis updates
        ↓
finalize_rca
```

## RCA100 data boundary

The application downloads only the **agent-facing** case files:

```text
task.json
metrics.parquet
logs.parquet
traces.parquet
events.parquet
alerts.parquet
topology.json
```

There is intentionally no runtime code that downloads `answer_key` / ground truth. Dataset files are external, ignored by Git and not bundled in release archives.

RCA100 is published under **CC BY-NC-SA 4.0**. Review the upstream license before redistribution or commercial use.

## Tool surface

| Agent | Tools |
| --- | --- |
| Log Agent | `query_logs`, `analyze_log_patterns` |
| Metric Agent | `list_metrics`, `query_metrics` |
| Trace Agent | `search_traces`, `get_trace` |
| Context Agent | `query_events`, `query_alerts`, `get_topology_neighbors` |
| Coordinator | `delegate_agents`, `update_hypotheses`, `finalize_rca` |

Tools accept model-generated filters such as service, operation, keyword, severity, duration and time range. The gateway inspects RCA100 Parquet schemas where source fields may vary.

## Evidence contract

Each real query produces structured Evidence similar to:

```ts
{
  id: "EV03",
  taskId: "T002",           // Harness AgentTask that produced it
  datasetTaskId: "t039",    // RCA100 case
  modality: "trace",
  source: "RCA100-v1.1",
  summary: "...",
  observation: { ... },
  rawRef: "rca100://t039/traces/search/...",
  entityRefs: ["checkout"],
  timeRange: { start: "...", end: "..." },
  createdBy: "trace"
}
```

`summary` is LLM-friendly, `observation` contains structured facts, and `rawRef` is opaque. Exact-query Evidence reuse remains supported. Coverage/subset reuse is intentionally deferred to v8.3.

## Task/tracing contract

Task lifecycle events are part of the RCA SSE stream:

```text
task.created
task.started
task.completed
task.failed
task.cancelled
task.timed_out
```

Relevant task/tool/evidence events carry correlation data such as:

```text
investigationId
runId
taskId
agent
toolCallId
evidenceId
```

This provides one traceable path from Coordinator delegation to Specialist task, tool calls and resulting Evidence.

## Current validation boundary

The current cloud workspace cannot reach npm registry (`EAI_AGAIN`) and runs Node `22.16.0`, while the project requires Node `>=22.19.0`. Therefore a full `npm install && npm run build` and real Pi + DuckDB + `t039` end-to-end run cannot be honestly executed here.

What is validated in this workspace:

- deterministic Harness tests: **13/13 passing**;
- server RCA syntax checks;
- server/frontend TypeScript semantic checks using temporary external-module stubs;
- RCA100 download/smoke script parse checks;
- `git diff --check`;
- static preservation review for the real RCA100/DuckDB and ground-truth-isolation paths.

Run `npm install`, `npm run rca100:smoke -- --case t039`, `npm run harness:test`, `npm run build`, then the recommended case on a networked local machine for the final real-environment verification.

## Engineering roadmap

See:

- [`docs/rca-harness-roadmap.md`](./docs/rca-harness-roadmap.md)
- [`docs/v8.1-harness-spec.md`](./docs/v8.1-harness-spec.md)
- [`docs/v8.1-harness-tasks.md`](./docs/v8.1-harness-tasks.md)

Next milestones remain intentionally separated:

- **v8.2** — SQLite InvestigationRepository, checkpoints, persisted EventLog, restart/resume;
- **v8.3** — NormalizedQuery, Evidence coverage/subset reuse, RawRef reuse and reuse metrics;
- **v8.4** — isolated ground-truth evaluator, multi-case/103-case benchmark and accuracy/cost/latency reporting.
