# RCA Multi-Agent Architecture

## Runtime flow

```text
User / Incident
      |
      v
RcaRuntime (Coordinator)
      |
      +-- fan-out -------------------+
      |                              |
      v                              v
  Log Agent                     Metric Agent
      |                              |
      v                              v
get_log_overview              query_metrics
      |                              |
      +---------- EvidenceStore -----+
                     |
              hypothesis update
                     |
      +-- dynamic second round ------+
      |                              |
      v                              v
 Trace Agent                    Change Agent
      |                              |
      v                              v
query_traces                  get_deployments
      |                              |
      +---------- EvidenceStore -----+
                     |
                     v
              FakeLlmClient
                synthesis
                     |
                     v
               RCA conclusion
```

The current demo keeps the orchestration, state transitions, Evidence Store and SSE event model real. Only two integration edges are fake:

1. `FakeLlmClient`: deterministic stand-in for Pi/LLM reasoning.
2. `FakeToolGateway`: deterministic stand-in for Loki/Elasticsearch, Prometheus, Tempo/Jaeger and deployment/config systems.

This lets the real providers be swapped in without redesigning the UI or coordinator state model.

## Server modules

- `server/rca/runtime.ts` — Coordinator and multi-round fan-out/fan-in orchestration.
- `server/rca/agent-manager.ts` — Agent lifecycle and Tool execution boundary.
- `server/rca/tool-gateway.ts` — controlled RCA Tool registry; fake data source implementation today.
- `server/rca/fake-llm.ts` — fake specialist summaries and final synthesis.
- `server/rca/evidence-store.ts` — normalized query key, evidenceId and rawRef reuse.
- `server/rca/event-channel.ts` — ordered in-memory event history + subscribers for SSE replay.
- `server/rca/service.ts` — incident-to-runtime lifecycle.
- `server/routes/rca.ts` — snapshot, run and SSE endpoints.

## Event protocol

The browser first loads a snapshot, then reconnects from `snapshot.stream.lastEventId`.

```text
investigation.reset
investigation.status
investigation.phase
agent.updated
tool.started
tool.completed
evidence.created
hypothesis.updated
coordinator.message
rca.completed
runtime.error
```

Every event contains monotonically increasing `id` and a stable `streamId` so the UI can replay missed events after reconnecting.

## Evidence contract

```ts
interface EvidenceView {
  id: string;          // EV01
  type: AgentKind;     // log / metric / trace / change
  label: string;
  source: string;
  summary: string;
  rawRef: string;      // reference to raw source data
  queryKey: string;    // normalized Tool + args key
  createdAt: string;
}
```

`EvidenceStore` sorts object keys before building a query key. Repeating the same logical query with a different JSON key order returns the same evidenceId instead of creating duplicate evidence.

## Current fake investigation

Round 1 runs in parallel:

- Log Agent → `get_log_overview`
- Metric Agent → `query_metrics`

Coordinator sees both point to the payment database connection pool, supports H1 and rejects the order-service resource hypothesis. It then dynamically schedules round 2:

- Trace Agent → `query_traces`
- Change Agent → `get_deployments`

The second round connects the database latency to the deployment/config change. The synthesizer then emits a causal-chain RCA result.

## Real integration path

1. Replace `FakeToolGateway.execute()` with adapters for Loki/ES, Prometheus and Tempo/Jaeger.
2. Replace `FakeLlmClient` with Pi Agent sessions while preserving structured Agent result contracts.
3. Persist Evidence/Investigation state in a repository instead of in-memory maps.
4. Add timeout/budget/cancellation and per-Agent concurrency limits.
5. Add tool query coverage reuse (requested range contained by existing evidence), not only exact query-key reuse.
