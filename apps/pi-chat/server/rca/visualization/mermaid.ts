import type { FlowNode, InvestigationFlowModel } from "./types";

function escapeLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br/>");
}

function classFor(node: FlowNode): string {
  if (node.kind === "root-cause" || node.kind === "conclusion") return "conclusion";
  if (node.status === "rejected" || node.status === "failed" || node.status === "interrupted") {
    return "failed";
  }
  if (node.status === "supported" || node.status === "success") return "success";
  if (node.status === "recovery" || node.kind === "recovery") return "recovery";
  if (node.kind === "hypothesis") return "hypothesis";
  if (node.kind === "alert") return "alert";
  return "neutral";
}

function mermaidId(value: string, index: number): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_");
  const safe = /^[A-Za-z]/.test(normalized) ? normalized : "N_" + normalized;
  return safe + "_" + index;
}

export function compileMermaidFlow(model: InvestigationFlowModel): string {
  const lines = [
    "flowchart TD",
    "  classDef neutral fill:#ffffff,stroke:#cbd5e1,color:#1f2937,stroke-width:1px;",
    "  classDef alert fill:#fff7ed,stroke:#fdba74,color:#7c2d12,stroke-width:1px;",
    "  classDef hypothesis fill:#f8fafc,stroke:#94a3b8,color:#1f2937,stroke-width:1px;",
    "  classDef success fill:#ecfdf5,stroke:#6ee7b7,color:#065f46,stroke-width:1.2px;",
    "  classDef failed fill:#fef2f2,stroke:#fca5a5,color:#991b1b,stroke-width:1.2px;",
    "  classDef recovery fill:#f5f3ff,stroke:#c4b5fd,color:#5b21b6,stroke-width:1.2px;",
    "  classDef conclusion fill:#111827,stroke:#111827,color:#ffffff,stroke-width:1.4px;",
  ];

  const idMap = new Map<string, string>();
  model.nodes.forEach((node, index) => {
    const id = mermaidId(node.id, index);
    idMap.set(node.id, id);
    lines.push("  " + id + "[\"" + escapeLabel(node.label) + "\"]");
    lines.push("  class " + id + " " + classFor(node) + ";");
  });

  for (const edge of model.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue;
    const arrow = edge.dashed ? "-.->" : "-->";
    const label = edge.label ? "|\"" + escapeLabel(edge.label) + "\"|" : "";
    lines.push("  " + from + " " + arrow + label + " " + to);
  }

  return lines.join("\n");
}
