# RCA Multi-Agent UI Prototype

Based on the `ai-hermes/pi-lessons` `feat/pi-chat-0920` frontend shape, redesigned as a multi-agent RCA investigation workspace.

## Fake flow

The first version intentionally does not call a real LLM. Click **重新运行 Fake 调查** to simulate:

1. Coordinator creates an investigation plan.
2. Log + Metric agents run in parallel.
3. Trace + Change agents continue validation.
4. Hypotheses are supported/rejected from collected evidence.
5. A causal-chain RCA conclusion is generated.

## Run

```bash
cd apps/pi-chat
pnpm install
pnpm dev
```

## Next integration seam

Replace the local timeout-driven state transitions in `src/App.tsx` with existing pi-lessons SSE events, while keeping the UI data contracts for Agent, Hypothesis and Evidence.
