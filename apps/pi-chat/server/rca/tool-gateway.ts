import { randomUUID } from "node:crypto";

import type { AgentKind } from "../../shared/rca-types";
import type { PutEvidenceInput } from "./evidence-store";
import type { AgentTask } from "./fake-llm";

export interface ToolPlan {
  id: string;
  agent: AgentKind;
  name: "get_log_overview" | "query_metrics" | "query_traces" | "get_deployments";
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  display: string;
  evidence: PutEvidenceInput[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeToolGateway {
  createPlan(kind: AgentKind, task: AgentTask): ToolPlan {
    const plans: Record<AgentKind, Omit<ToolPlan, "id" | "agent">> = {
      log: {
        name: "get_log_overview",
        args: {
          service: "payment-service",
          window: task.window,
          level: "ERROR",
          keyword: "connection timeout",
        },
      },
      metric: {
        name: "query_metrics",
        args: {
          service: "payment-service",
          window: task.window,
          metrics: ["db_pool_active", "db_pool_waiting", "http_5xx", "http_p99"],
        },
      },
      trace: {
        name: "query_traces",
        args: {
          service: "order-service",
          downstream: "payment-service",
          window: task.window,
          minDurationMs: 1000,
        },
      },
      change: {
        name: "get_deployments",
        args: {
          service: "payment-service",
          window: task.window,
          changeType: ["deployment", "config"],
        },
      },
    };
    return { id: randomUUID(), agent: kind, ...plans[kind] };
  }

  async execute(plan: ToolPlan): Promise<ToolExecutionResult> {
    const delay: Record<AgentKind, number> = {
      log: 760,
      metric: 960,
      trace: 820,
      change: 680,
    };
    await sleep(delay[plan.agent]);

    const result: Record<AgentKind, ToolExecutionResult> = {
      log: {
        display: "命中 1,832 条错误日志；connection timeout 聚类 286 条，10:31 起明显抬升。",
        evidence: [
          {
            type: "log",
            label: "连接超时日志",
            source: "fake-loki",
            summary: "payment-service 在 10:31 后出现 286 条 connection timeout。",
            rawRef: "fake-loki://payment-service/connection-timeout/10:31-10:40",
            query: plan.args,
          },
        ],
      },
      metric: {
        display: "db_pool_active 接近 max，waiting_requests 与 P99 同步抬升。",
        evidence: [
          {
            type: "metric",
            label: "连接池指标异常",
            source: "fake-prometheus",
            summary: "db_pool_active 持续接近 max，waiting_requests 明显抬升。",
            rawRef: "fake-prom://payment-service/db-pool",
            query: plan.args,
          },
        ],
      },
      trace: {
        display: "慢 Trace 的主要耗时集中在 payment-service → DB span。",
        evidence: [
          {
            type: "trace",
            label: "order → payment 调用耗时",
            source: "fake-tempo",
            summary: "关键 span P99 从 90ms 升至 3.4s，异常集中于数据库访问。",
            rawRef: "fake-tempo://order-to-payment/slow-spans",
            query: plan.args,
          },
        ],
      },
      change: {
        display: "10:28 发布 v1.8.4，同时发现数据库连接池 maxSize 配置发生变更。",
        evidence: [
          {
            type: "change",
            label: "v1.8.4 发布记录",
            source: "fake-change-center",
            summary: "故障发生前 3 分钟完成发布，并修改连接池配置。",
            rawRef: "fake-change://payment-service/v1.8.4",
            query: plan.args,
          },
        ],
      },
    };
    return result[plan.agent];
  }
}
