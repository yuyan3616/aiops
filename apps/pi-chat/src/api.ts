import type { InvestigationSnapshot, RcaStreamEvent } from "@shared/rca-types";

export interface IncidentSummary {
  id: string;
  title: string;
  time: string;
  status: string;
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function listIncidents() {
  return readJson<IncidentSummary[]>("/api/rca/incidents");
}

export function getInvestigation(id: string) {
  return readJson<InvestigationSnapshot>(`/api/rca/incidents/${encodeURIComponent(id)}`);
}

export function runInvestigation(id: string) {
  return readJson<{ accepted: true; runId: string }>(
    `/api/rca/incidents/${encodeURIComponent(id)}/run`,
    { method: "POST" },
  );
}

export function connectInvestigationEvents(
  id: string,
  after: number,
  onEvent: (event: RcaStreamEvent) => void,
  onConnectionChange: (connected: boolean) => void,
) {
  const query = new URLSearchParams({ after: String(after) });
  const source = new EventSource(
    `/api/rca/incidents/${encodeURIComponent(id)}/stream?${query.toString()}`,
  );
  source.onopen = () => onConnectionChange(true);
  source.onerror = () => onConnectionChange(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RcaStreamEvent);
    } catch {
      // Ignore malformed demo events and let the next valid SSE event continue the stream.
    }
  };
  return source;
}
