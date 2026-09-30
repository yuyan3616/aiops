import { RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  ConversationInvestigationState,
  InvestigationVisualizationArtifact,
} from "@shared/types";

import {
  getInvestigationVisualization,
  regenerateInvestigationVisualization,
} from "@/api";
import { Button } from "@components/ui/button";

import { MermaidFlowViewer } from "./MermaidFlowViewer";

const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 420;
const COMPACT_BREAKPOINT = 760;

function clampDrawerWidth(value: number): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  if (window.innerWidth < COMPACT_BREAKPOINT) return window.innerWidth;
  const maxWidth = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, window.innerWidth - 320));
  return Math.max(MIN_WIDTH, Math.min(maxWidth, value));
}

function durationLabel(value: number | undefined): string {
  if (value === undefined) return "—";
  const seconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? minutes + "m " + rest + "s" : rest + "s";
}

function tokensLabel(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value >= 100_000 ? 0 : 1) + "K";
  return (value / 1_000_000).toFixed(1) + "M";
}

function costLabel(value: number | undefined): string {
  return value === undefined ? "—" : "$" + value.toFixed(4);
}

interface InvestigationDetailDrawerProps {
  open: boolean;
  investigationId?: string;
  investigationState?: ConversationInvestigationState;
  visualizationRevision: number;
  onClose: () => void;
}

export function InvestigationDetailDrawer({
  open,
  investigationId,
  investigationState,
  visualizationRevision,
  onClose,
}: InvestigationDetailDrawerProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [artifact, setArtifact] = useState<InvestigationVisualizationArtifact>();
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const resizeRef = useRef<{ pointerId: number } | undefined>(undefined);

  const terminalForVisualization =
    investigationState === "completed" ||
    investigationState === "inconclusive" ||
    investigationState === "failed" ||
    investigationState === "cancelled";

  const refresh = useCallback(async () => {
    if (!open || !investigationId || !terminalForVisualization) return;
    setLoading(true);
    setRequestError("");
    try {
      const next = await getInvestigationVisualization(investigationId);
      setArtifact(next);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [investigationId, open, terminalForVisualization]);

  useEffect(() => {
    setArtifact(undefined);
    setRequestError("");
  }, [investigationId]);

  useEffect(() => {
    if (!open || !terminalForVisualization) return;
    void refresh();
  }, [
    open,
    investigationId,
    investigationState,
    visualizationRevision,
    terminalForVisualization,
    refresh,
  ]);

  useEffect(() => {
    if (!open || !artifact || (artifact.status !== "pending" && artifact.status !== "generating")) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [artifact, open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const onResize = () => setWidth((current) => clampDrawerWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < COMPACT_BREAKPOINT) return;
    resizeRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("rca-drawer-resizing");
  };

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    setWidth(clampDrawerWidth(window.innerWidth - event.clientX));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = undefined;
    document.body.classList.remove("rca-drawer-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(
    () => () => {
      document.body.classList.remove("rca-drawer-resizing");
    },
    [],
  );

  if (!open) return null;

  const summary = artifact?.summary;

  return (
    <aside
      className="investigation-detail-drawer"
      style={{ width: clampDrawerWidth(width) }}
      role="dialog"
      aria-modal="false"
      aria-label="排障详情"
    >
      <div
        className="investigation-drawer-resize-handle"
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden
      />

      <header className="investigation-drawer-header">
        <div className="investigation-drawer-heading">
          <strong>排障详情</strong>
          <span>{investigationId}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭排障详情">
          <X size={17} />
        </Button>
      </header>

      <div className="investigation-drawer-content">
        {summary && (
          <div className="investigation-summary-grid">
            <div>
              <span>调查耗时</span>
              <strong>{durationLabel(summary.durationMs)}</strong>
            </div>
            <div>
              <span>专家花费</span>
              <strong>{costLabel(summary.expertCost)}</strong>
            </div>
            <div>
              <span>专家 Token</span>
              <strong>{tokensLabel(summary.expertTokens)}</strong>
            </div>
            <div>
              <span>预算</span>
              <strong>
                {summary.budget.total > 0
                  ? summary.budget.used + " / " + summary.budget.total
                  : "—"}
              </strong>
            </div>
          </div>
        )}

        <div className="investigation-flow-heading">
          <div>
            <strong>调查流程</strong>
            <span>流程概览</span>
          </div>
          {artifact?.status === "failed" && (
            <Button
              variant="outline"
              disabled={regenerating}
              onClick={async () => {
                if (!investigationId) return;
                setRegenerating(true);
                setRequestError("");
                try {
                  const next = await regenerateInvestigationVisualization(investigationId);
                  setArtifact(next);
                } catch (error) {
                  setRequestError(error instanceof Error ? error.message : String(error));
                } finally {
                  setRegenerating(false);
                }
              }}
            >
              <RotateCcw size={14} />
              重新生成
            </Button>
          )}
        </div>

        {investigationState === "running" ? (
          <div className="investigation-visualization-state">
            <span className="investigation-visualization-spinner" aria-hidden />
            <strong>调查进行中</strong>
            <span>整体排障流程会在 Investigation 完成后异步生成，并自动在这里展示。</span>
          </div>
        ) : investigationState === "interrupted" ? (
          <div className="investigation-visualization-state">
            <strong>调查已中断</strong>
            <span>恢复调查并完成收敛后，会生成整体排障流程。</span>
          </div>
        ) : investigationState === "unavailable" ? (
          <div className="investigation-visualization-state investigation-visualization-error">
            <strong>调查状态暂不可用</strong>
            <span>当前会话仍保留 Investigation 关联，但持久化状态暂时无法读取。</span>
          </div>
        ) : loading && !artifact ? (
          <div className="investigation-visualization-state">
            <strong>正在读取排障流程…</strong>
          </div>
        ) : requestError ? (
          <div className="investigation-visualization-state investigation-visualization-error">
            <strong>排障流程读取失败</strong>
            <span>{requestError}</span>
            <Button variant="outline" onClick={() => void refresh()}>
              <RotateCcw size={14} />
              重试
            </Button>
          </div>
        ) : artifact?.status === "pending" || artifact?.status === "generating" ? (
          <div className="investigation-visualization-state">
            <span className="investigation-visualization-spinner" aria-hidden />
            <strong>正在生成排障流程…</strong>
            <span>这是 RCA 完成后的派生视图，不影响已经得到的调查结论。</span>
          </div>
        ) : artifact?.status === "failed" ? (
          <div className="investigation-visualization-state investigation-visualization-error">
            <strong>排障流程生成失败</strong>
            <span>{artifact.error ?? "可视化任务未成功完成。"}</span>
          </div>
        ) : artifact?.status === "ready" && artifact.mermaid ? (
          <MermaidFlowViewer source={artifact.mermaid} />
        ) : (
          <div className="investigation-visualization-state">
            <strong>暂无可视化内容</strong>
          </div>
        )}

        {summary?.budget.total ? (
          <div className="investigation-budget-note">
            Primary {summary.budget.primaryUsed}/{summary.budget.primaryLimit}
            <span>·</span>
            Recovery {summary.budget.recoveryUsed}/{summary.budget.recoveryLimit}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
