import { AgentThreadCard } from "@components/AgentThreadCard";
import { Markdown } from "@components/Markdown";
import { MessageActions } from "@components/MessageActions";
import { ThinkingItem } from "@components/ThinkingItem";
import { ToolCard } from "@components/ToolCard";
import type { MessageListItem } from "@shared/types";

export function MessageItem({
  item,
  showActions,
}: {
  item: MessageListItem;
  showActions: boolean;
}) {
  if (item.kind === "thinking") {
    return <ThinkingItem thinking={item.thinking} />;
  }
  if (item.kind === "tool") {
    return <ToolCard tool={item.tool} />;
  }
  if (item.kind === "agent") {
    return <AgentThreadCard agent={item.agent} />;
  }
  const user = item.message.role === "user";
  return (
    <>
      {!user && (
        <div className="agent-identity assistant-agent-identity">
          <span className="agent-identity-avatar">P</span>
          <strong>Main Agent</strong>
          <span className="agent-identity-context">回答</span>
        </div>
      )}
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
