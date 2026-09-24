# RCA Multi-Agent Prototype

This branch turns the `pi-lessons` chat shell into a server-orchestrated multi-Agent RCA workspace.

## What is real vs fake

The **LLM and observability data sources are fake** for now. The following engineering path is real:

- Coordinator multi-round orchestration
- parallel Agent fan-out / fan-in
- Agent lifecycle state
- controlled Tool Gateway
- Tool call records
- Evidence Store (`evidenceId`, `rawRef`, normalized `queryKey`)
- hypothesis support/rejection
- ordered SSE domain events and replay cursor
- server snapshot + frontend reducer
- RCA conclusion and causal chain

## Demo flow

```text
Coordinator
   |
   +--> Log Agent ----> get_log_overview --+
   |                                         |
   +--> Metric Agent -> query_metrics -------+--> Evidence + Hypothesis update
                                             |
                                      dynamic decision
                                             |
   +--> Trace Agent --> query_traces --------+
   |                                         |
   +--> Change Agent -> get_deployments -----+--> Synthesis --> RCA conclusion
```

## Run

```bash
cd apps/pi-chat
npm install
npm run dev
```

- Web: Vite default dev address
- API: `http://127.0.0.1:4328`
- Health: `/health`
- Snapshot: `/api/rca/incidents/demo`
- Start investigation: `POST /api/rca/incidents/demo/run`
- SSE: `/api/rca/incidents/demo/stream?after=0`

The UI automatically starts the demo investigation when the server snapshot is idle.

## Validation performed in this workspace

The cloud environment could not download npm dependencies, so a full Vite/Hono build could not be executed here. The implementation was still validated in two ways:

1. TypeScript syntax transpilation across all TS/TSX source files: no syntax diagnostics.
2. The pure RCA runtime was transpiled independently and executed end-to-end:
   - 4 Agents completed
   - 4 Tool calls succeeded
   - EV01–EV04 generated
   - H1/H2 supported and H3/H4 rejected
   - final status `completed`, phase `4`
   - 42 ordered domain events emitted

See [`docs/rca-architecture.md`](docs/rca-architecture.md) for the event protocol and replacement seams for real Pi/LLM and observability providers.
