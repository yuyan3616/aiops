import { Maximize2, Moon, RotateCcw, Sun, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@components/ui/button";

const MERMAID_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.esm.min.mjs";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | undefined;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import(/* @vite-ignore */ MERMAID_MODULE_URL)
      .then((module) => module.default as MermaidApi)
      .catch((error) => {
        mermaidPromise = undefined;
        throw error;
      });
  }
  return mermaidPromise;
}

interface TransformState {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

function systemDiagramTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function MermaidFlowViewer({ source }: { source: string }) {
  const rawId = useId();
  const renderId = "rca-mermaid-" + rawId.replace(/[^A-Za-z0-9_-]/g, "");
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        pointerId: number;
        startX: number;
        startY: number;
        transform: TransformState;
      }
    | undefined
  >(undefined);
  const autoFitRef = useRef(true);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">(systemDiagramTheme);
  const [dragging, setDragging] = useState(false);
  const [transform, setTransform] = useState<TransformState>({
    scale: 1,
    x: 0,
    y: 0,
  });

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const svgElement = canvasRef.current?.querySelector("svg");
    if (!viewport || !svgElement) return;

    const viewBox = svgElement.viewBox?.baseVal;
    const naturalWidth = viewBox?.width || svgElement.getBoundingClientRect().width;
    const naturalHeight = viewBox?.height || svgElement.getBoundingClientRect().height;
    if (!naturalWidth || !naturalHeight) return;

    svgElement.style.width = naturalWidth + "px";
    svgElement.style.height = naturalHeight + "px";
    svgElement.style.maxWidth = "none";

    const padding = 36;
    const availableWidth = Math.max(80, viewport.clientWidth - padding * 2);
    const availableHeight = Math.max(80, viewport.clientHeight - padding * 2);
    const scale = clampScale(
      Math.min(1.25, availableWidth / naturalWidth, availableHeight / naturalHeight),
    );
    setTransform({
      scale,
      x: (viewport.clientWidth - naturalWidth * scale) / 2,
      y: (viewport.clientHeight - naturalHeight * scale) / 2,
    });
    autoFitRef.current = true;
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    autoFitRef.current = false;
    setTransform((current) => {
      const scale = clampScale(current.scale * factor);
      const centerX = viewport.clientWidth / 2;
      const centerY = viewport.clientHeight / 2;
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        scale,
        x: centerX - worldX * scale,
        y: centerY - worldY * scale,
      };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setSvg("");

    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
          flowchart: {
            htmlLabels: true,
            useMaxWidth: false,
            curve: "basis",
          },
        });
        const rendered = await mermaid.render(
          renderId + "-" + retryVersion + "-" + theme,
          source,
        );
        if (cancelled) return;
        setSvg(rendered.svg);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [renderId, retryVersion, source, theme]);

  useEffect(() => {
    if (!svg) return;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, svg]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!autoFitRef.current) return;
      requestAnimationFrame(fit);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!svg) return;
      event.preventDefault();
      autoFitRef.current = false;
      const rect = viewport.getBoundingClientRect();
      const pointX = event.clientX - rect.left;
      const pointY = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      setTransform((current) => {
        const scale = clampScale(current.scale * factor);
        const worldX = (pointX - current.x) / current.scale;
        const worldY = (pointY - current.y) / current.scale;
        return {
          scale,
          x: pointX - worldX * scale,
          y: pointY - worldY * scale,
        };
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [svg]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !svg) return;
    autoFitRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      transform,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTransform({
      ...drag.transform,
      x: drag.transform.x + event.clientX - drag.startX,
      y: drag.transform.y + event.clientY - drag.startY,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="mermaid-viewer">
      <div className="mermaid-toolbar" aria-label="流程图控制">
        <Button variant="ghost" size="icon" onClick={() => zoomBy(0.84)} aria-label="缩小流程图">
          <ZoomOut size={16} />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => zoomBy(1.18)} aria-label="放大流程图">
          <ZoomIn size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            autoFitRef.current = true;
            fit();
          }}
          aria-label="适应窗口"
        >
          <Maximize2 size={16} />
        </Button>
        <span className="mermaid-scale">{Math.round(transform.scale * 100)}%</span>
        <div className="mermaid-toolbar-spacer" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          aria-label={theme === "light" ? "切换为深色流程图" : "切换为浅色流程图"}
        >
          {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
        </Button>
      </div>

      {error ? (
        <div className="mermaid-render-error" role="alert">
          <strong>流程图渲染失败</strong>
          <span>{error}</span>
          <Button
            variant="outline"
            onClick={() => setRetryVersion((current) => current + 1)}
          >
            <RotateCcw size={14} />
            重试
          </Button>
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={"mermaid-viewport" + (dragging ? " mermaid-viewport-dragging" : "")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label="RCA 排障流程图，可拖动并使用滚轮缩放"
        >
          {!svg && <div className="mermaid-render-loading">正在渲染流程图…</div>}
          <div
            ref={canvasRef}
            className="mermaid-canvas"
            style={{
              transform:
                "translate(" +
                transform.x +
                "px, " +
                transform.y +
                "px) scale(" +
                transform.scale +
                ")",
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}
