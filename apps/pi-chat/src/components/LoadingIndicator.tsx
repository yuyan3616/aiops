import { useEffect, useState } from "react";

const chevronDelays = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

export function LoadingIndicator({ runStartedAt }: { runStartedAt?: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [runStartedAt]);

  const seconds = runStartedAt === undefined ? undefined : Math.max(0, now - runStartedAt) / 1000;
  const elapsed =
    seconds === undefined
      ? undefined
      : seconds < 60
        ? `${seconds.toFixed(1)}s`
        : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;

  return (
    <div className="message-loading" role="status" aria-label="正在生成回复">
      <span className="loading-grid" aria-hidden>
        {chevronDelays.map((delay, index) => (
          <span key={index} className="loading-pixel" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className="loading-label">正在生成</span>
      {elapsed !== undefined && <span className="loading-elapsed">{elapsed}</span>}
    </div>
  );
}
