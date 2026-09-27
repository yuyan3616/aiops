import { Markdown } from "@components/Markdown";
import { Button } from "@components/ui/button";
import type { ThinkingBlock } from "@shared/types";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

export function ThinkingItem({ thinking }: { thinking: ThinkingBlock }) {
  const { text, completed, source, label } = thinking;
  const [open, setOpen] = useState(!completed);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- collapse when thinking completes.
    if (completed) setOpen(false);
  }, [completed]);

  const displayLabel = label ?? (source === "rca-projection" ? "调查过程" : "思考过程");
  return (
    <div className="main-agent-block">
      <div className="agent-identity">
        <span className="agent-identity-avatar">P</span>
        <strong>Main Agent</strong>
        <span className="agent-identity-context">
          {source === "rca-projection" ? "RCA 编排" : "Pi Agent"}
        </span>
      </div>
      <div className="thinking">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Brain size={16} />
        <span>{displayLabel}</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </Button>
      <div
        className={"thinking-content " + (open ? "thinking-content-open" : "")}
        aria-hidden={!open}
      >
        <div className="thinking-content-inner">
          <div className="thinking-content-body">
            <Markdown content={text || "正在思考…"} />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
