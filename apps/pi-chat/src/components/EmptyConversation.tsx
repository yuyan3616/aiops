import { PiLogo } from "@components/PiLogo";
import { Button } from "@components/ui/button";
import { ChevronRight } from "lucide-react";

export function EmptyConversation({ onPrompt }: { onPrompt: (text: string) => void }) {
  const prompts = ["排查一次接口延迟异常", "分析服务 5xx 错误原因", "定位一次告警的根因"];
  return (
    <section className="empty-conversation">
      <div className="empty-icon">
        <PiLogo size={66} />
      </div>
      <h1>今天要调查什么问题？</h1>
      <p>描述告警、异常现象，或选择一个排障场景</p>
      <div className="prompt-list">
        {prompts.map((prompt) => (
          <Button variant="outline" key={prompt} onClick={() => onPrompt(prompt)}>
            {prompt}
            <ChevronRight size={15} />
          </Button>
        ))}
      </div>
    </section>
  );
}
