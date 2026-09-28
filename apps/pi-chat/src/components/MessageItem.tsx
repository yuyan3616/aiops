import { AgentThreadCard } from "@components/AgentThreadCard";
import { HypothesisBoard } from "@components/HypothesisBoard";
import { InvestigationReportCard } from "@components/InvestigationReportCard";
import { Markdown } from "@components/Markdown";
import { MessageActions } from "@components/MessageActions";
import { ThinkingItem } from "@components/ThinkingItem";
import { ToolCard } from "@components/ToolCard";
import type { MessageListItem } from "@shared/types";

function MainAgentIdentity() {
  return (
    <div className="agent-identity assistant-agent-identity">
      <span className="agent-identity-avatar">P</span>
      <strong>Main Agent</strong>
    </div>
  );
}

export function MessageItem({
  item,
  showActions,
  showMainAgentIdentity = false,
}: {
  item: MessageListItem;
  showActions: boolean;
  showMainAgentIdentity?: boolean;
}) {
  const identity = showMainAgentIdentity ? <MainAgentIdentity /> : null;

  if (item.kind === "thinking") {
    return (
      <>
        {identity}
        <ThinkingItem thinking={item.thinking} />
      </>
    );
  }
  if (item.kind === "tool") {
    return (
      <>
        {identity}
        <ToolCard tool={item.tool} />
      </>
    );
  }
  if (item.kind === "hypotheses") {
    return (
      <>
        {identity}
        <HypothesisBoard board={item.board} />
      </>
    );
  }
  if (item.kind === "agent") {
    return <AgentThreadCard agent={item.agent} />;
  }
  if (item.kind === "report") {
    return (
      <>
        {identity}
        <InvestigationReportCard report={item.report} />
      </>
    );
  }

  const user = item.message.role === "user";
  return (
    <>
      {!user && identity}
      <article className={"message-row " + (user ? "user-row" : "")}>
        <div className="message-column">
          <div className={"bubble " + (user ? "user-bubble" : "assistant-bubble")}>
            <Markdown content={item.message.text} />
          </div>
          {showActions && (
            <MessageActions message={item.message} timestamp={item.message.timestamp} />
          )}
        </div>
      </article>
    </>
  );
}
