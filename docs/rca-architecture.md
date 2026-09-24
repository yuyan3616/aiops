# RCA Multi-Agent Architecture — v7

## 1. Architecture

```text
                         +----------------------+
User / Incident -------->| Pi Coordinator       |
                         | AgentSession          |
                         +----------+-----------+
                                    |
                     delegate_agents(assignments)
                                    |
                     +--------------+--------------+
                     |                             |
                     v                             v
             +---------------+             +---------------+
             | Log Agent     |             | Metric Agent  |
             | Pi Session    |             | Pi Session    |
             +-------+-------+             +-------+-------+
                     |                             |
             get_log_overview               query_metrics
                     |                             |
                     +--------------+--------------+
                                    |
                              EvidenceStore
                                    |
                                    v
                              Coordinator
                                    |
                        evidence-driven next round
                                    |
                     +--------------+--------------+
                     |                             |
                     v                             v
             +---------------+             +---------------+
             | Trace Agent   |             | Change Agent  |
             | Pi Session    |             | Pi Session    |
             +-------+-------+             +-------+-------+
                     |                             |
                query_traces               get_deployments
                     |                             |
                     +--------------+--------------+
                                    |
                              EvidenceStore
                                    |
                    update_hypotheses / finalize_rca
                                    |
                                    v
                              RCA conclusion
```

## 2. Why this is genuinely multi-Agent

The specialists are not plain functions pretending to be Agents. Every delegated role creates an independent Pi `AgentSession` with:

- its own system prompt
- its own model turn / tool loop
- an isolated tool capability
- its own result summarization

The Coordinator is another independent Pi `AgentSession`. It does not query observability data directly. It decides when to call `delegate_agents`, which specialists to include in that round, how to update hypotheses, and when to call `finalize_rca`.

Assignments passed in a single `delegate_agents` call are executed concurrently by `Promise.all`, preserving the fan-out / fan-in structure.

## 3. Capability isolation

The embedded sessions intentionally disable Pi's default coding tools:

```ts
noTools: "builtin"
```

The custom `DefaultResourceLoader` also disables discovery of external behavior:

```text
noExtensions
noSkills
noPromptTemplates
noThemes
noContextFiles
```

Coordinator tools:

```text
delegate_agents
update_hypotheses
finalize_rca
```

Specialist tools:

```text
Log Agent      -> get_log_overview
Metric Agent   -> query_metrics
Trace Agent    -> query_traces
Change Agent   -> get_deployments
```

This is an important engineering boundary: a Log Agent cannot arbitrarily run shell commands or call deployment tools.

## 4. Fake vs real boundary

`server/rca/pi-agent-client.ts` is now real Pi SDK integration.

`server/rca/tool-gateway.ts` is still deterministic demo infrastructure:

```text
fake-loki
fake-prometheus
fake-tempo
fake-change-center
```

The next production-data version only needs to replace the Tool Gateway implementations with real clients while preserving their contracts.

## 5. Evidence contract

```ts
interface EvidenceView {
  id: string;          // EV01
  type: AgentKind;     // log / metric / trace / change
  label: string;
  source: string;
  summary: string;
  rawRef: string;
  queryKey: string;
  createdAt: string;
}
```

`EvidenceStore` normalizes query objects before building `queryKey`. Equivalent logical queries reuse the same evidence instead of creating duplicate context.

## 6. Coordinator tools

### `delegate_agents`

The Coordinator sends one or more assignments:

```json
{
  "assignments": [
    { "agent": "log", "goal": "检查超时错误模式" },
    { "agent": "metric", "goal": "检查连接池与 P99" }
  ]
}
```

The Server executes those specialist sessions concurrently and returns structured summaries plus Evidence IDs.

### `update_hypotheses`

The Coordinator explicitly binds evidence to candidate hypotheses. Unknown Evidence IDs are filtered server-side so the model cannot fabricate references into application state.

### `finalize_rca`

Finalization requires at least one Evidence ID that actually exists in the Evidence Store. The Server rejects a conclusion containing only invented IDs.

## 7. Thinking stream

The browser still consumes:

```text
thinking.started
thinking.delta
thinking.completed
```

In v7 these deltas come from the Coordinator's **ordinary assistant text** that the system prompt explicitly requires to be a short, user-visible investigation summary before tool calls. Provider hidden reasoning / private chain-of-thought is not forwarded to the browser.

This preserves the Pi Chat thinking-style UX while keeping the displayed content bounded and appropriate for users.

## 8. Authentication

`ModelRuntime.create()` resolves credentials through Pi. Environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and Gemini/Google keys can be placed in `apps/pi-chat/.env`.

The app supports optional explicit model pinning with:

```text
RCA_MODEL_PROVIDER
RCA_MODEL_ID
```

When unset, Pi chooses its configured/default authenticated model.

## 9. Event protocol

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
thinking.started
thinking.delta
thinking.completed
rca.completed
runtime.error
```

Snapshot + ordered SSE replay remains unchanged from v6, so the frontend did not need a protocol redesign for real Pi Agents.

## 10. Next version

Replace `FakeToolGateway` with real adapters:

```text
get_log_overview  -> Loki / Elasticsearch
query_metrics     -> Prometheus
query_traces      -> Tempo / Jaeger
get_deployments   -> Kubernetes / GitLab / ArgoCD
```

After that, add production controls: deadlines, token/tool budgets, cancellation propagation, per-Agent concurrency limits, persistent Evidence state, and broader evidence-coverage reuse.
