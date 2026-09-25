# RCA Architecture — v8.0

## Goal

v8.0 proves one complete data-driven RCA loop on RCA100 `t039`: real Pi AgentSessions select tools, tools execute real queries over public telemetry files, and the Coordinator can finalize only from recorded Evidence.

## Runtime layers

```text
User / recommended RCA100 case
              |
              v
        RcaRuntime
              |
              v
     Pi Coordinator Session
        |      |      |
        | RCA investigation Skill
        |      |      |
        v      v      v
   delegate  hypotheses  finalize
        |
        +-------------------------------+
        |              |                |
        v              v                v
     Log Agent     Metric Agent     Trace Agent      Context Agent
        |              |                |                 |
        +--------------+-------+--------+-----------------+
                               |
                               v
                      Rca100ToolGateway
                               |
                     normalized query args
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
          DuckDbParquetEngine          topology.json
                 |
                 v
   metrics/logs/traces/events/alerts.parquet
                 |
                 v
                         EvidenceStore
                               |
                               v
                      Coordinator context
```

## Responsibility boundaries

### System prompt

Defines identity and hard constraints. The Coordinator cannot claim a root cause without Evidence, and Specialist Agents cannot use generic coding tools.

### RCA Skill

`apps/pi-chat/skills/rca-investigation/SKILL.md` contains investigation methodology. It teaches *how to investigate* but performs no data access.

### Tools

Tools perform concrete read/query operations. They return factual observations plus Evidence. They never return a root-cause label as a shortcut.

### Dataset adapter

`server/datasets/rca100` owns RCA100 file locations, downloads, validation and DuckDB access. Agent code does not know OSS URLs or Parquet paths.

### EvidenceStore

Evidence is the contract between Tool execution and reasoning. Each record contains modality, normalized query payload, structured observation, entity references, time range and raw reference.

### Ground truth

Ground truth is outside the investigation runtime. v8.0 never downloads `answer_key`. A later evaluator will use a separate context/process so the Agent cannot observe labels before completing its prediction.

## Agent roles

### Coordinator

- reads alert/task context;
- applies RCA Skill;
- maintains hypotheses;
- dynamically chooses specialists;
- requires multi-modal support before finalizing;
- outputs root-cause entity, fault type, causal chain and evidence IDs.

### Log Agent

Tools:
- `query_logs`
- `analyze_log_patterns`

Focus: application error/warning/message evidence and recurring log patterns.

### Metric Agent

Tools:
- `list_metrics`
- `query_metrics`

Focus: metric discovery and incident-window statistics. Metric names should be discovered before assuming an unknown name.

### Trace Agent

Tools:
- `search_traces`
- `get_trace`

Focus: latency/error spans, service propagation and concrete trace structure.

### Context Agent

Tools:
- `query_events`
- `query_alerts`
- `get_topology_neighbors`

Focus: Kubernetes/environment context, related alert lifecycle and reference topology.

## Data flow

1. `RcaRuntime` publishes `investigation.reset` and running status.
2. Repository prepares the seven t039 case files.
3. Runtime emits `dataset.ready`.
4. Coordinator starts and emits user-visible reasoning summaries.
5. Coordinator calls `delegate_agents`.
6. Specialists call scoped custom tools.
7. Tool Gateway queries RCA100 and writes Evidence.
8. Evidence IDs are returned to Specialists and then Coordinator.
9. Coordinator updates hypotheses and may delegate another round.
10. `finalize_rca` validates at least two valid Evidence IDs across at least two modalities.
11. Runtime publishes `rca.completed`.

## RCA100 t039 case files

```text
data/rca100/cases/t039/
├── task.json
├── metrics.parquet
├── logs.parquet
├── traces.parquet
├── events.parquet
├── alerts.parquet
└── topology.json
```

Data files are ignored by Git and not included in release archives.

## Production replacement seam

The Agent/Coordinator contracts should survive a future production migration. Replace the dataset-backed query layer with adapters such as:

```text
query_logs       -> Loki / Elasticsearch
query_metrics    -> Prometheus / VictoriaMetrics
search_traces    -> Tempo / Jaeger
query_events     -> Kubernetes API / event store
query_alerts     -> alert platform
get_topology_*   -> CMDB / service catalog / trace-derived graph
```

The important invariant is that Tools continue to return the same Evidence contract.
