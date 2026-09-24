# RCA Multi-Agent Prototype — v7 Pi AgentSession

This branch turns the `pi-lessons` chat shell into a chat-first multi-Agent RCA workspace.

## v7 status: reasoning is real, observability data is still fake

The **LLM / Agent layer now uses real Pi AgentSession**. The observability integrations intentionally remain fake so you can validate multi-Agent orchestration before wiring production Loki / Prometheus / Tempo / deployment systems.

### Real in v7

- Pi `ModelRuntime` authentication and model selection
- real Coordinator `AgentSession`
- independent real specialist `AgentSession`s: Log / Metric / Trace / Change
- Coordinator tool-driven orchestration (`delegate_agents`)
- same-round specialist fan-out / fan-in with `Promise.all`
- specialist tool isolation: each specialist only receives its own observability tool
- Evidence Store (`evidenceId`, `rawRef`, normalized `queryKey`)
- model-driven hypothesis updates (`update_hypotheses`)
- model-driven RCA completion (`finalize_rca`)
- user-visible streamed analysis summaries over SSE
- one-click recommended demo entry
- manual user prompts are forwarded to the real Coordinator

### Still fake in v7

- `get_log_overview` → fake Loki response
- `query_metrics` → fake Prometheus response
- `query_traces` → fake Tempo / Jaeger response
- `get_deployments` → fake deployment/config response

So the boundary is now:

```text
Real Pi Coordinator
        |
        | delegate_agents
        v
+-------------------------------+
| Real specialist Pi Sessions   |
| Log / Metric / Trace / Change |
+-------------------------------+
        |
        | isolated custom tool
        v
FakeToolGateway
        |
        v
EvidenceStore
        |
        +---- back to Coordinator
```

## Local run with a real model

Pi `0.86.1` requires **Node.js >= 22.19.0**.

```bash
cd apps/pi-chat
cp .env.example .env
```

Edit `.env` and configure at least one model provider, for example:

```bash
OPENAI_API_KEY=sk-...
```

or:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

or:

```bash
GEMINI_API_KEY=...
```

Then:

```bash
npm install
npm run dev
```

Open the Vite address shown in the terminal. The empty page contains **“为你推荐” → order-service 5xx 激增**. Click **一键运行** and the request will go through the real Coordinator and real specialist Pi sessions.

### Optional: pin a specific model

Normally Pi uses its configured default model and otherwise falls back to the first authenticated available model. To pin one explicitly:

```bash
RCA_MODEL_PROVIDER=openai
RCA_MODEL_ID=<a model id registered by your Pi installation>
```

Both values must be supplied together. If you leave them unset, Pi chooses an available model automatically.

## What happens after clicking the recommended demo

```text
User prompt
   |
   v
Pi Coordinator AgentSession
   |
   | user-visible summary streamed to thinking.*
   |
   +--> delegate_agents([log, metric])  (model decides)
   |          |
   |          +--> Log Agent Pi Session --> get_log_overview --> EVxx
   |          +--> Metric Agent Pi Session --> query_metrics  --> EVxx
   |
   +--> update_hypotheses(...)
   |
   +--> delegate_agents([trace, change]) (only if model decides it is useful)
   |          |
   |          +--> Trace Agent Pi Session  --> query_traces    --> EVxx
   |          +--> Change Agent Pi Session --> get_deployments --> EVxx
   |
   +--> update_hypotheses(...)
   |
   +--> finalize_rca(...)
   v
RCA conclusion + causal chain
```

The prompt strongly recommends Log + Metric as the low-cost first round for the bundled demo, but the orchestration is no longer a hard-coded two-round state machine: the Coordinator chooses which agents to dispatch through tools based on the evidence it sees.

## API / SSE

- API: `http://127.0.0.1:4328`
- Health: `/health`
- Snapshot: `/api/rca/incidents/demo`
- Start: `POST /api/rca/incidents/demo/run` with `{ "prompt": "..." }`
- SSE: `/api/rca/incidents/demo/stream?after=0`

## Important safety / isolation detail

RCA Pi sessions do **not** receive Pi's default coding tools (`read`, `bash`, `edit`, `write`). v7 uses `noTools: "builtin"` and disables discovered extensions, skills, prompt templates, themes, and context files for these embedded RCA sessions. The Coordinator only receives orchestration tools; each specialist only receives its corresponding fake observability tool.

This makes the eventual production replacement seam straightforward: replace `FakeToolGateway`, not the Coordinator or UI.

See [`docs/rca-architecture.md`](docs/rca-architecture.md) for details.
