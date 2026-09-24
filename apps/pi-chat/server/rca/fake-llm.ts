import type { AgentKind, EvidenceView } from "../../shared/rca-types";

export interface AgentTask {
  service: string;
  window: string;
  goal: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeLlmClient {
  async summarizeAgent(kind: AgentKind, evidence: EvidenceView[]): Promise<string> {
    await sleep(180);
    const summaries: Record<AgentKind, string> = {
      log: "发现大量 connection timeout，异常从 10:31 开始聚集。",
      metric: "db_pool_active 接近上限，P99 与 5xx 同步上升。",
      trace: "order → payment span 从 90ms 升至 3.4s，耗时集中在 DB 调用。",
      change: "10:28 发布 v1.8.4，包含数据库连接池 maxSize 调整。",
    };
    return evidence.length > 0 ? summaries[kind] : "未获取到可用于判断的有效证据。";
  }

  async synthesize(): Promise<{ rootCause: string; causalChain: string[] }> {
    await sleep(420);
    return {
      rootCause:
        "payment-service v1.8.4 将数据库连接池 maxSize 配置调低，峰值流量下连接池被耗尽，请求排队并触发数据库连接超时，最终导致 order-service 5xx 激增。",
      causalChain: [
        "v1.8.4 发布",
        "连接池 maxSize 调低",
        "连接池耗尽",
        "DB 请求排队/超时",
        "payment-service 延迟升高",
        "order-service 5xx 激增",
      ],
    };
  }
}
