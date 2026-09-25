# Pi Chat RCA — v8.0 RCA100 t039

A chat-first multi-agent RCA demo built on Pi 0.86.1. v8.0 replaces the previous hard-coded observability results with **real queries over the public RCA100 v1.1 `t039` telemetry files**.

The current milestone deliberately focuses on one reproducible case:

- Dataset: RCA100 v1.1
- Case: `t039`
- Alert: `checkout响应时间突增告警`
- Modalities: metrics, logs, traces, Kubernetes events, alerts, topology
- LLM/agents: real Pi AgentSession
- Data access: real DuckDB queries over Parquet/JSON
- Ground truth: **not downloaded and not exposed to agents**

## Architecture

```text
RCA100 task.json
      |
      v
Pi Coordinator AgentSession
      |
      | delegate_agents
      +----------------+----------------+----------------+
      |                |                |                |
      v                v                v                v
 Log Agent        Metric Agent      Trace Agent      Context Agent
      |                |                |                |
 query_logs       list_metrics      search_traces     query_events
 analyze_*        query_metrics     get_trace         query_alerts
                                                    topology_neighbors
      |                |                |                |
      +----------------+--------+-------+----------------+
                               |
                               v
                        RCA Tool Gateway
                               |
                               v
                         Evidence Store
                               |
                               v
                      RCA100 Repository
                               |
                  +------------+-------------+
                  |                          |
                  v                          v
              DuckDB                      JSON
        logs/metrics/traces/         task/topology
          events/alerts
```

The Tool layer returns observations and Evidence, not a root-cause answer. The Coordinator must build the RCA from evidence IDs across at least two independent modalities.

## Skill vs Tool

v8.0 includes `skills/rca-investigation/SKILL.md` as the Coordinator's RCA methodology:

- distinguish root cause / propagation / impact;
- treat alert entity as a starting point, not the answer;
- use multiple modalities;
- explicitly support/reject hypotheses;
- stop only when the evidence chain closes.

The Skill is injected server-side into the Coordinator system context. Pi's generic filesystem/coding tools remain disabled for embedded RCA sessions. Specialist Agents receive only their scoped observability tools.

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

On Windows PowerShell / cmd, copy the file with your normal file command and edit `.env`.

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

Both variables must be configured together. Leave both unset to let Pi select an authenticated model.

### 3. Install

```bash
npm install
```

The Pi packages are pinned to exactly `0.86.1`. DuckDB Node API is pinned for the RCA100 query engine.

### 4. Prepare `t039`

The runtime defaults to:

```env
RCA100_AUTO_DOWNLOAD=true
```

so the first demo run downloads the seven public case files into:

```text
apps/pi-chat/data/rca100/cases/t039/
```

You can prefetch them explicitly:

```bash
npm run rca100:download -- --case t039
```

Then verify that DuckDB can really open the local case and inspect all five Parquet modalities:

```bash
npm run rca100:smoke -- --case t039
```

The downloader validates JSON files and the Parquet `PAR1` header/footer before accepting a case. The smoke command additionally prints row counts and detected schemas through the same DuckDB Node runtime used by the application.

The telemetry directory is ignored by Git and is not bundled in the source archive.

### 5. Start

```bash
npm run dev
```

Open the web page, choose the recommended **RCA100 · t039** case, and click **一键运行**.

The expected runtime path is:

```text
prepare t039 telemetry
        ↓
Pi Coordinator
        ↓
dynamic specialist delegation
        ↓
real DuckDB queries over RCA100
        ↓
Evidence EVxx
        ↓
hypothesis updates
        ↓
finalize_rca
```

## RCA100 data boundary

The application downloads only the **agent-facing case files** from the public RCA100 v1.1 case endpoint:

```text
task.json
metrics.parquet
logs.parquet
traces.parquet
events.parquet
alerts.parquet
topology.json
```

There is intentionally no runtime code that downloads `answer_key` / ground truth. This prevents leakage into the Agent context and keeps the case suitable for later benchmark evaluation.

The dataset itself is external and is not redistributed in this repository. RCA100 is published under **CC BY-NC-SA 4.0**; attribution, non-commercial use and share-alike terms apply to the dataset material. Review the upstream `RCA100/LICENSE` before redistribution or reuse.

Dataset citation used by the upstream project: *RCA-100: A Chain-Reasoning Benchmark for Root Cause Analysis on Cloud-Native Microservices* (Wen et al., 2026).

## Tool surface

| Agent | Tools |
| --- | --- |
| Log Agent | `query_logs`, `analyze_log_patterns` |
| Metric Agent | `list_metrics`, `query_metrics` |
| Trace Agent | `search_traces`, `get_trace` |
| Context Agent | `query_events`, `query_alerts`, `get_topology_neighbors` |
| Coordinator | `delegate_agents`, `update_hypotheses`, `finalize_rca` |

Tools accept model-generated filters such as service, operation, keyword, severity, duration and time range. The gateway inspects Parquet schemas before querying where the RCA100 source schema can vary.

## Evidence contract

Each query produces structured Evidence similar to:

```ts
{
  id: "EV03",
  taskId: "t039",
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

`summary` is LLM-friendly; `observation` contains structured facts; `rawRef` identifies the underlying query result. Exact-query Evidence reuse remains supported. Coverage/subset reuse is planned for the next milestone.

## Current validation boundary

This workspace can statically validate the code but cannot access npm registry / the RCA100 OSS binary files from the execution container, so v8.0 could not perform a real model + DuckDB + t039 end-to-end run here.

The implementation is therefore designed against:

- Pi `0.86.1` source APIs;
- RCA100 v1.1 published schemas and public case layout;
- DuckDB Node Neo API.

Run the commands above on a networked local machine to execute the real telemetry query path.

## Next milestones

v8.0 intentionally stops at the single-case data-driven loop. Next milestones are:

- v8.1: query normalization + evidence coverage/subset reuse + stronger hypothesis lifecycle;
- v8.2: isolated ground-truth evaluator + batch execution across RCA100 cases + accuracy/token/tool-call/latency metrics.
