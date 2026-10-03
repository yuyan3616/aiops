import {
  ROOT_CONTEXT,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
} from "@opentelemetry/api";
import { AggregationType, type ViewOptions } from "@opentelemetry/sdk-metrics";

export type LifecycleOutcome = "success" | "error" | "cancelled" | "incomplete";

export interface RuntimeMetricRecorder {
  recordAgentCompletion(input: {
    span: Span;
    durationSeconds: number;
    agentType: string;
    outcome: LifecycleOutcome;
  }): void;
  recordTurnCompletion(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: LifecycleOutcome;
  }): void;
  recordProviderGenerationCompletion(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: LifecycleOutcome;
  }): void;
  recordProviderResponseHeader(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: "success" | "error";
  }): void;
  recordToolCompletion(input: {
    span: Span;
    durationSeconds: number;
    toolName: string;
    outcome: LifecycleOutcome;
  }): void;
}

export const HISTOGRAM_BOUNDARIES_SECONDS = {
  tool: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  provider: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300],
  agentTurn: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600],
} as const;

export const RUNTIME_METRIC_INSTRUMENTS = {
  agentRuns: "pi_agent_runs",
  agentDuration: "pi_agent_run_duration",
  modelTurns: "pi_model_turns",
  modelTurnDuration: "pi_model_turn_duration",
  providerGenerations: "pi_provider_generations",
  providerGenerationDuration: "pi_provider_generation_duration",
  providerResponseHeaderDuration: "pi_provider_response_header_duration",
  toolCalls: "pi_tool_calls",
  toolCallDuration: "pi_tool_call_duration",
} as const;

const LABEL_LIMITS = {
  provider: 8,
  model: 32,
  tool: 64,
} as const;

function parseAllowlist(raw: string | undefined, limit: number): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, limit),
  );
}

function boundedValue(value: string | undefined, allowlist: ReadonlySet<string>): string {
  if (!value) return "other";
  return allowlist.has(value) ? value : "other";
}

export function createPiRuntimeMetricViews(): ViewOptions[] {
  const histogram = (
    instrumentName: string,
    boundaries: readonly number[],
  ): ViewOptions => ({
    instrumentName,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: {
        boundaries: [...boundaries],
        recordMinMax: true,
      },
    },
  });

  return [
    histogram(RUNTIME_METRIC_INSTRUMENTS.agentDuration, HISTOGRAM_BOUNDARIES_SECONDS.agentTurn),
    histogram(
      RUNTIME_METRIC_INSTRUMENTS.modelTurnDuration,
      HISTOGRAM_BOUNDARIES_SECONDS.agentTurn,
    ),
    histogram(
      RUNTIME_METRIC_INSTRUMENTS.providerGenerationDuration,
      HISTOGRAM_BOUNDARIES_SECONDS.provider,
    ),
    histogram(
      RUNTIME_METRIC_INSTRUMENTS.providerResponseHeaderDuration,
      HISTOGRAM_BOUNDARIES_SECONDS.provider,
    ),
    histogram(RUNTIME_METRIC_INSTRUMENTS.toolCallDuration, HISTOGRAM_BOUNDARIES_SECONDS.tool),
  ];
}

export class PiRuntimeMetrics implements RuntimeMetricRecorder {
  private readonly agentRuns: Counter;
  private readonly agentDuration: Histogram;
  private readonly modelTurns: Counter;
  private readonly modelTurnDuration: Histogram;
  private readonly providerGenerations: Counter;
  private readonly providerGenerationDuration: Histogram;
  private readonly providerResponseHeaderDuration: Histogram;
  private readonly toolCalls: Counter;
  private readonly toolCallDuration: Histogram;
  private readonly providers: ReadonlySet<string>;
  private readonly models: ReadonlySet<string>;
  private readonly tools: ReadonlySet<string>;
  private readonly reportedFailures = new Set<string>();

  constructor(
    meter: Meter,
    env: NodeJS.ProcessEnv = process.env,
    private readonly onFailure: (operation: string, error: unknown) => void = () => undefined,
  ) {
    this.providers = parseAllowlist(env.OTEL_METRIC_PROVIDER_ALLOWLIST, LABEL_LIMITS.provider);
    this.models = parseAllowlist(env.OTEL_METRIC_MODEL_ALLOWLIST, LABEL_LIMITS.model);
    this.tools = parseAllowlist(env.OTEL_METRIC_TOOL_ALLOWLIST, LABEL_LIMITS.tool);

    this.agentRuns = meter.createCounter(RUNTIME_METRIC_INSTRUMENTS.agentRuns, {
      description: "Completed Pi agent runs",
      unit: "1",
    });
    this.agentDuration = meter.createHistogram(RUNTIME_METRIC_INSTRUMENTS.agentDuration, {
      description: "Pi agent run duration",
      unit: "s",
    });
    this.modelTurns = meter.createCounter(RUNTIME_METRIC_INSTRUMENTS.modelTurns, {
      description: "Completed Pi model turns",
      unit: "1",
    });
    this.modelTurnDuration = meter.createHistogram(
      RUNTIME_METRIC_INSTRUMENTS.modelTurnDuration,
      {
        description: "Pi model turn duration, including tool execution in that turn",
        unit: "s",
      },
    );
    this.providerGenerations = meter.createCounter(
      RUNTIME_METRIC_INSTRUMENTS.providerGenerations,
      {
        description:
          "Completed top-level Pi provider generations; provider-internal retry attempts are not individually observable in Pi 0.86.1",
        unit: "1",
      },
    );
    this.providerGenerationDuration = meter.createHistogram(
      RUNTIME_METRIC_INSTRUMENTS.providerGenerationDuration,
      {
        description: "Top-level Pi provider generation duration including stream consumption",
        unit: "s",
      },
    );
    this.providerResponseHeaderDuration = meter.createHistogram(
      RUNTIME_METRIC_INSTRUMENTS.providerResponseHeaderDuration,
      {
        description: "Pi provider HTTP response-header latency",
        unit: "s",
      },
    );
    this.toolCalls = meter.createCounter(RUNTIME_METRIC_INSTRUMENTS.toolCalls, {
      description: "Completed Pi tool calls",
      unit: "1",
    });
    this.toolCallDuration = meter.createHistogram(RUNTIME_METRIC_INSTRUMENTS.toolCallDuration, {
      description: "Pi tool call duration",
      unit: "s",
    });
  }

  recordAgentCompletion(input: {
    span: Span;
    durationSeconds: number;
    agentType: string;
    outcome: LifecycleOutcome;
  }): void {
    const attributes = {
      agent_type: input.agentType === "main" ? "main" : "other",
      status: input.outcome,
    };
    this.safeRecord("agent_completion", input.span, attributes, () => {
      this.agentRuns.add(1, attributes, this.spanContext(input.span));
      this.agentDuration.record(
        input.durationSeconds,
        attributes,
        this.spanContext(input.span),
      );
    });
  }

  recordTurnCompletion(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: LifecycleOutcome;
  }): void {
    const attributes = this.modelAttributes(input.provider, input.model, input.outcome);
    this.safeRecord("turn_completion", input.span, attributes, () => {
      this.modelTurns.add(1, attributes, this.spanContext(input.span));
      this.modelTurnDuration.record(
        input.durationSeconds,
        attributes,
        this.spanContext(input.span),
      );
    });
  }

  recordProviderGenerationCompletion(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: LifecycleOutcome;
  }): void {
    const attributes = this.modelAttributes(input.provider, input.model, input.outcome);
    this.safeRecord("provider_generation_completion", input.span, attributes, () => {
      this.providerGenerations.add(1, attributes, this.spanContext(input.span));
      this.providerGenerationDuration.record(
        input.durationSeconds,
        attributes,
        this.spanContext(input.span),
      );
    });
  }

  recordProviderResponseHeader(input: {
    span: Span;
    durationSeconds: number;
    provider?: string;
    model?: string;
    outcome: "success" | "error";
  }): void {
    const attributes = this.modelAttributes(input.provider, input.model, input.outcome);
    this.safeRecord("provider_response_header", input.span, attributes, () => {
      this.providerResponseHeaderDuration.record(
        input.durationSeconds,
        attributes,
        this.spanContext(input.span),
      );
    });
  }

  recordToolCompletion(input: {
    span: Span;
    durationSeconds: number;
    toolName: string;
    outcome: LifecycleOutcome;
  }): void {
    const attributes = {
      tool_name: boundedValue(input.toolName, this.tools),
      status: input.outcome,
    };
    this.safeRecord("tool_completion", input.span, attributes, () => {
      this.toolCalls.add(1, attributes, this.spanContext(input.span));
      this.toolCallDuration.record(
        input.durationSeconds,
        attributes,
        this.spanContext(input.span),
      );
    });
  }

  private modelAttributes(
    provider: string | undefined,
    model: string | undefined,
    outcome: LifecycleOutcome | "success" | "error",
  ): Attributes {
    return {
      provider: boundedValue(provider, this.providers),
      model: boundedValue(model, this.models),
      status: outcome,
    };
  }

  private spanContext(span: Span) {
    return trace.setSpan(ROOT_CONTEXT, span);
  }

  private safeRecord(
    operation: string,
    _span: Span,
    _attributes: Attributes,
    record: () => void,
  ): void {
    try {
      record();
    } catch (error) {
      if (this.reportedFailures.has(operation)) return;
      this.reportedFailures.add(operation);
      try {
        this.onFailure(operation, error);
      } catch {
        // Telemetry diagnostics must never affect business execution.
      }
    }
  }
}
