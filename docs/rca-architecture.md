# RCA Architecture — v8.1 Controlled Harness

## Goal

v8.0 proved the real-data RCA loop on RCA100 `t039`. v8.1 keeps the same Coordinator/Specialist/Tool/Evidence behavior while adding a lightweight RCA-specific Harness around Pi so specialist execution is bounded, cancellable, context-controlled and traceable.

The core rule is:

> **Agent decides what to investigate; Harness decides how that work executes safely.**

## Runtime layers

```text
Web Client
   | HTTP / SSE
   v
RcaRuntime
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
   +--> ContextBuilder
   +--> Investigation AbortController
   |
   v
AgentManager
   |
   +--> persistent Log AgentSession
   +--> persistent Metric AgentSession
   +--> persistent Trace AgentSession
   `--> persistent Context AgentSession
          |
          v
      BudgetGuard
          |
      ToolGuard
          |
      ToolGateway
          |
      EvidenceStore
          |
   RCA100 Repository
       /       \
   DuckDB    topology.json
```

## Ownership boundaries

### Pi Runtime owns

- provider/model integration;
- Agent turn loop;
- one AgentSession's own transcript;
- provider-level transient retry;
- tool-calling protocol;
- model streaming.

### RCA Harness owns

- AgentTask lifecycle;
- per-Agent serialization and global specialist concurrency;
- TaskPolicy and hard budgets;
- cross-Agent context assembly;
- investigation/task cancellation propagation;
- Tool input/output guardrails;
- task/tool/evidence correlation metadata.

### RCA Domain owns

- Coordinator planning and hypotheses;
- specialist role boundaries;
- EvidenceStore;
- RCA conclusion validation;
- RCA100 task/case semantics.

## AgentTask

A specialist assignment is no longer an implicit method call. The Harness creates a stable Task before execution:

```text
queued -> running -> succeeded
                |-> failed
                |-> timed_out
queued/running  |-> cancelled
```

Task and dataset IDs are intentionally different:

```text
T002  = Harness AgentTask
 t039 = RCA100 dataset case
```

This distinction is carried into Evidence and ToolRun correlation.

## Scheduling

One active investigation owns one persistent Specialist Pi Session per Agent role.

```text
Log Session     concurrency = 1
Metric Session  concurrency = 1
Trace Session   concurrency = 1
Context Session concurrency = 1

global specialist concurrency = 3 by default
```

Therefore two Log tasks serialize, while Log + Metric may overlap. The Coordinator still decides which roles to delegate; the Scheduler only controls execution safety.

## ContextBuilder

Specialists never receive other Agents' complete transcripts. `ContextBuilder` produces `SpecialistExecutionContext` from:

1. case/incident metadata;
2. current assignment;
3. explicitly referenced Evidence;
4. Evidence attached to selected hypotheses;
5. bounded relevant/recent Evidence;
6. current TaskPolicy constraints.

The maximum Evidence set is deterministic and bounded by `maxEvidence`.

The Specialist's own Pi Session may retain its own role-local history across tasks; cross-Agent knowledge is shared through structured Evidence/Hypothesis state rather than transcript copying.

## Budgets

Default TaskPolicy:

```text
timeoutMs     60000
maxTurns          6
maxToolCalls     10
maxEvidence      12
maxAttempts       1
```

`BudgetGuard` counts specialist turns and tool calls in canonical execution points. The over-budget call/turn is rejected/aborted before unrestricted continuation. Reused Evidence does not consume the new-Evidence budget.

Pi remains responsible for provider-level transient retry; v8.1 does not multiply retries at Task/Tool layers.

## Cancellation

```text
POST /api/rca/incidents/:id/abort
          |
          v
Investigation AbortController
      /            \
queued tasks      running tasks
   |                  |
cancelled        child signal
                      |
                AgentSession.abort()
```

No new tasks are accepted after root cancellation. Fatal runtime termination also aborts in-flight work instead of leaving orphan Specialist runs.

## ToolGuard and ToolGateway

The layers have different responsibilities:

```text
Agent intent
   |
ToolGuard input
   |- ACL
   |- string/array/limit caps
   `- incident time-window validation
   |
ToolGateway
   |- translate intent to RCA100/DuckDB query
   `- return factual observation + Evidence candidate
   |
ToolGuard output
   |- row/string/serialized-size bounds
   |- Evidence shape validation
   |- opaque rawRef validation
   `- filesystem / answer-key leak prevention
```

Neither layer returns a root-cause shortcut.

## EvidenceStore

Evidence is the shared fact contract between otherwise isolated AgentSessions. A record includes:

- Harness `taskId`;
- RCA100 `datasetTaskId`;
- modality/source;
- normalized query payload used by the current exact-key cache;
- structured observation;
- compact summary;
- entity/time references;
- opaque `rawRef`.

Exact-query reuse is preserved. Coverage/subset matching is deferred to v8.3.

## Task and tracing events

The EventChannel carries task lifecycle events in addition to Agent/Tool/Evidence events:

```text
task.created
task.started
task.completed
task.failed
task.cancelled
task.timed_out
```

Relevant events carry correlation fields:

```text
investigationId
runId
taskId
agent
toolCallId
evidenceId
```

This makes one failed/slow task traceable from Coordinator delegation through AgentSession, Tool execution and Evidence/error.

## RCA100 / Ground Truth boundary

The investigation runtime sees only:

```text
task.json
metrics.parquet
logs.parquet
traces.parquet
events.parquet
alerts.parquet
topology.json
```

`answer_key` remains outside the runtime and is not downloaded by the application. Evaluation stays deferred to v8.4.

## Production replacement seam

The Harness and Agent contracts should survive replacing RCA100 with production adapters:

```text
query_logs       -> Loki / Elasticsearch
query_metrics    -> Prometheus / VictoriaMetrics
search_traces    -> Tempo / Jaeger
query_events     -> Kubernetes API / event store
query_alerts     -> alert platform
get_topology_*   -> CMDB / service catalog / trace-derived graph
```

The invariant is that Tools continue to return bounded factual results and Evidence contracts.

## Planning documents

- [`rca-harness-roadmap.md`](./rca-harness-roadmap.md)
- [`v8.1-harness-spec.md`](./v8.1-harness-spec.md)
- [`v8.1-harness-tasks.md`](./v8.1-harness-tasks.md)

v8.2 remains persistence/resume, v8.3 remains Evidence intelligence, and v8.4 remains benchmark/evaluation. Those concerns are intentionally not folded into v8.1.
