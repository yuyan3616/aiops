import type { HypothesisBoard as HypothesisBoardData } from "@shared/types";

const statusLabels: Record<string, string> = {
  possible: "待验证",
  investigating: "调查中",
  supported: "获得支持",
  rejected: "已排除",
  confirmed: "已确认",
};

export function HypothesisBoard({ board }: { board: HypothesisBoardData }) {
  return (
    <section className="hypothesis-board" aria-label="RCA 假设池">
      <div className="hypothesis-board-title">
        <strong>假设池</strong>
        <span>{board.hypotheses.length}</span>
      </div>
      <div className="hypothesis-board-list">
        {board.hypotheses.map((hypothesis) => (
          <div className="hypothesis-row" key={hypothesis.id}>
            <code>{hypothesis.id}</code>
            <span className="hypothesis-statement">{hypothesis.statement || "正在补充假设…"}</span>
            <span className={"hypothesis-status " + hypothesis.status}>
              {statusLabels[hypothesis.status] ?? hypothesis.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
