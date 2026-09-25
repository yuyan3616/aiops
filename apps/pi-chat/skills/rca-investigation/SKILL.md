---
name: rca-investigation
description: Evidence-driven multi-signal root cause analysis for cloud-native incidents.
---

# RCA Investigation

Use this method when investigating an incident from alerts, metrics, logs, traces, events, and topology.

## Investigation principles

1. Start from the alert entity and incident window; do not assume the alerted entity is the root cause.
2. Prefer factual observations over interpretations. Every important claim must point to one or more Evidence IDs.
3. Separate **cause**, **propagation**, and **impact**. A downstream symptom is not automatically the root cause.
4. Use at least two independent modalities before finalizing when they are available. For latency incidents, traces plus metrics/logs are particularly useful.
5. Use topology to understand upstream/downstream relationships before attributing propagation.
6. Treat temporal correlation as evidence, not proof. Kubernetes events/alerts can corroborate a change or infrastructure incident but should not replace service evidence.
7. Reject hypotheses explicitly when evidence contradicts them; do not keep every hypothesis alive.
8. Stop when the evidence chain explains: root-cause entity -> mechanism/fault type -> propagation -> alerted symptom.

## Tool strategy

- **Metric Agent**: discover relevant metrics first if metric names are unknown; compare the incident window across entities and services.
- **Log Agent**: search error/timeout/resource messages and aggregate repeated patterns; do not infer a fault from a single log line.
- **Trace Agent**: use slow/error traces to localize where latency or failure accumulates; inspect a concrete trace when necessary.
- **Context Agent**: use events, alerts, and topology to validate infrastructure/change context and service relationships.

## Finalization contract

The final RCA should include:
- root-cause entity;
- fault/mechanism description;
- a short causal chain ending at the alert symptom;
- supporting Evidence IDs only from tool results;
- no claims that are unsupported by collected evidence.
