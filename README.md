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
- streamed RCA analysis summaries (`thinking.started/delta/completed`)
- Pi Chat visual parity: original neutral palette, message bubbles, Thinking and ToolCard interaction patterns
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

The UI automatically starts the demo investigation when the server snapshot is idle. Thinking summaries stream inline in the chat and can be expanded/collapsed after completion.

## Validation performed in this workspace

The cloud environment could not download npm dependencies, so a full Vite/Hono build could not be executed here. The implementation was still validated with `git diff --check` plus an independently transpiled and executed pure RCA runtime:

- The pure RCA runtime completed end-to-end:
   - 4 Agents completed
   - 4 Tool calls succeeded
   - EV01–EV04 generated
   - H1/H2 supported and H3/H4 rejected
   - 3 streamed thinking-summary blocks completed
   - final status `completed`, phase `4`
   - 54 ordered domain events emitted

See [`docs/rca-architecture.md`](docs/rca-architecture.md) for the event protocol and replacement seams for real Pi/LLM and observability providers.
