import { Button } from "@components/ui/button";
import type { PendingHumanRequest } from "@shared/types";
import { CircleHelp } from "lucide-react";

export function HumanInputRequestCard({
  request,
  onSelect,
}: {
  request: PendingHumanRequest;
  onSelect(value: string): void;
}) {
  return (
    <section className="human-input-card" aria-live="polite">
      <div className="human-input-card-heading">
        <CircleHelp size={17} />
        <strong>需要你补充一个信息</strong>
      </div>
      <p>{request.question}</p>
      {request.options?.length ? (
        <div className="human-input-options">
          {request.options.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              onClick={() => onSelect(option.label)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {(request.allowFreeText || !request.options?.length) && (
        <small>也可以直接在下方输入框补充说明。</small>
      )}
    </section>
  );
}
