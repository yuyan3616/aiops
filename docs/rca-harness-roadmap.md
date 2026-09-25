# RCA Harness Roadmap — v8.1 to v8.4

> Status: **active roadmap — v8.1 implementation complete, real-environment E2E pending**
> Baseline: v8.0 / commit `0dd18df` (`feat: drive RCA demo from RCA100 t039`)  
> Purpose: keep the multi-agent runtime evolution explicit so later versions do not drift into ad-hoc orchestration.

## 1. Why this roadmap exists

v8.0 proves the business loop:

```text
RCA100 case
  -> Pi Coordinator AgentSession
  -> Specialist AgentSessions
  -> RCA tools
  -> DuckDB / Parquet / topology
  -> Evidence
  -> RCA conclusion
```

The next problem is no longer “can the Agents do RCA?”. It is “can the system run those Agents in a controlled, observable and recoverable way?”.

That engineering layer is the **Investigation Harness**.

The guiding principle is:

> **Agent decides what to do; Harness decides how to run it safely and reliably.**

## 2. Design references and what we borrow

We borrow mature runtime ideas without replacing Pi or importing another orchestration framework.

| Reference | Idea worth borrowing | What we do **not** adopt now |
| --- | --- | --- |
| Pi | AgentSession, ModelRuntime, model retry, compaction, streaming, tool loop | Reimplementing LLM/session internals |
| LangGraph | Separate execution checkpoint from shared store; resumable thread state | Replacing Pi with graph execution |
| AutoGen Core | Runtime-managed agent lifecycle; typed request/response between agents | General pub/sub message bus |
| OpenAI Agents SDK | Manager pattern, tool guardrails, hierarchical tracing | Framework migration |
| Temporal | Explicit task lifecycle, retry classification, cancellation, durable history | Temporal server/workers/deterministic workflow replay |

The target is therefore a **lightweight RCA-specific Harness built on Pi AgentSession**.

## 3. Layer ownership

```text
Web Client
  |  HTTP / SSE
  v
RCA Domain / Investigation Harness
  |- InvestigationRuntime
  |- TaskScheduler
  |- TaskPolicy / BudgetGuard
  |- ContextBuilder
  |- AgentManager
  |- ToolGuard
  |- EvidenceStore
  |- EventChannel
  |- (v8.2) CheckpointManager / Repository
  v
Pi Runtime
  |- AgentSession
  |- SessionManager
  |- ModelRuntime
  |- model retry
  |- compaction
  |- tool calling loop
  v
Tool Gateway / Dataset Adapter
  |- RCA100 now
  |- Loki / Prometheus / Tempo later
```

### Pi owns

- LLM/provider integration.
- Agent turn loop.
- One AgentSession's transcript and compaction.
- Provider-level transient retry.
- Tool call protocol and model streaming.

### RCA Harness owns

- Investigation and task lifecycle.
- Which Agent runs which task.
- Concurrency and per-Agent serialization.
- Task timeout/cancellation/budget.
- Cross-Agent context assembly.
- Tool input/output guardrails.
- Cross-Agent Evidence and Hypothesis state.
- Investigation-level tracing.
- v8.2 onward: checkpoint/resume.

## 4. v8.1 — Controlled Harness

### Goal

Make one RCA100 investigation **bounded, cancellable, context-controlled and traceable** without changing the core RCA behavior.

### Deliverables

1. **AgentTask** as the unit of specialist execution.
2. **TaskPolicy** with hard timeout / turn / tool-call / Evidence limits.
3. **TaskScheduler**:
   - global concurrency limit;
   - `concurrency = 1` per AgentSession;
   - different specialist Agents may run in parallel.
4. **ContextBuilder**:
   - no full cross-Agent transcript sharing;
   - only case metadata, assignment, selected hypotheses and selected Evidence.
5. **BudgetGuard** around Pi AgentSession events and custom tools.
6. **ToolGuard** for ACL, query range, row/size limits and output normalization.
7. **Cancellation propagation** from Investigation -> Task -> AgentSession -> Tool execution where supported.
8. **Task-level event/tracing metadata** (`investigationId`, `taskId`, `agent`, `toolCallId`, `evidenceId`).
9. Basic UI/server abort path.

### Explicit non-goals

- No SQLite/Postgres persistence.
- No server-restart resume.
- No semantic/vector context retrieval.
- No subset Evidence coverage reuse yet.
- No AutoGen-style message bus.
- No Temporal.
- No 103-case benchmark batch runner.

### Exit criteria

- [x] The same AgentSession never receives two simultaneous prompts.
- [x] A runaway specialist cannot exceed configured `maxToolCalls`, `maxTurns` or timeout.
- [x] User cancellation stops queued tasks and aborts running AgentSessions.
- [x] Every specialist execution has a Task record and terminal status.
- [x] Specialist prompts are assembled by `ContextBuilder`, not ad-hoc string concatenation in `AgentManager`.
- [ ] Existing `t039` demo still completes successfully in a real networked Pi + DuckDB environment (current cloud workspace cannot install dependencies; tracked as H81-096/H81-D09).

## 5. v8.2 — Durable Investigation

### Goal

Allow investigation state to survive a server restart without attempting token-level LLM replay.

### Planned components

- `InvestigationRepository` abstraction.
- SQLite implementation for local/demo use.
- Append-only investigation event log.
- Investigation checkpoint containing:
  - task records;
  - Agent status;
  - Evidence references;
  - hypotheses;
  - conclusion;
  - runtime version.
- Resume semantics:
  - completed tasks remain completed;
  - queued tasks remain queued;
  - tasks that were `running` become `interrupted` and are eligible for controlled rerun;
  - existing Evidence is retained and reused.

### Non-goals

- Exact resume from an LLM token boundary.
- Distributed workers.
- Exactly-once external side effects.

### Exit criteria

```text
start investigation
-> collect evidence
-> kill server
-> restart
-> restore checkpoint
-> rerun only interrupted work
-> finish RCA
```

## 6. v8.3 — Evidence Intelligence

### Goal

Reduce redundant data-source access and context cost by making Evidence reusable beyond exact-query cache hits.

### Planned components

- Canonical `NormalizedQuery` per modality.
- `EvidenceCoverageMatcher`.
- Raw result references with reusable query scope.
- Exact reuse and subset/coverage reuse.
- Evidence relevance selection for ContextBuilder.
- Reuse metrics:
  - exact hit rate;
  - coverage hit rate;
  - avoided tool executions;
  - avoided rows scanned;
  - estimated token savings.

### Example

```text
existing Evidence:
  service=checkout
  time=10:20..10:40
  level=ERROR

new query:
  service=checkout
  time=10:25..10:30
  level=ERROR
  keyword=timeout

=> reuse rawRef and filter locally instead of rescanning the source
```

## 7. v8.4 — Benchmark & Evaluation

### Goal

Move from one-case demonstration to repeatable evaluation across RCA100.

### Planned capabilities

- Ground-truth evaluator in a process/context isolated from Agents.
- Batch runner over selected cases, later all 103 cases.
- Metrics:
  - root-cause entity localization;
  - fault type identification;
  - causal-chain/evidence coverage;
  - latency;
  - tokens;
  - specialist tasks;
  - tool calls;
  - Evidence reuse rate;
  - failed/timeout task rate.
- Compare Harness policies and RCA strategies without changing dataset facts.

## 8. Version dependency order

```text
v8.0 RCA100 real data
   |
   v
v8.1 Controlled Harness
   |
   v
v8.2 Durable Investigation
   |
   v
v8.3 Evidence Intelligence
   |
   v
v8.4 Benchmark / Evaluation
```

Do not pull a later-version concern into an earlier version unless it is required to keep the earlier design extensible.

## 9. Architecture decisions to preserve

1. Coordinator-centered communication, not free peer-to-peer Agent chat.
2. One Pi AgentSession per Agent role per active investigation runtime.
3. Specialist Agents share Evidence, not full transcripts.
4. Tools return facts, never hidden ground-truth/root-cause shortcuts.
5. Ground truth is isolated from investigation runtime.
6. Tool Gateway remains the boundary between Agent intent and backend-specific queries.
7. Skills teach investigation methodology; Tools perform concrete data access.
8. Pi remains the underlying Agent runtime; Harness supplements rather than replaces it.

## 10. Document contract

Before starting a new milestone:

1. update this roadmap only if scope/order changed;
2. create/update the milestone `spec`;
3. create/update the milestone `tasks` checklist;
4. implementation changes must map to task IDs;
5. when finishing the milestone, record completed task IDs and unresolved follow-ups before moving to the next version.
