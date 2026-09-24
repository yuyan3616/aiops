import { RcaRuntime } from "./runtime";

export class RcaService {
  private readonly runtimes = new Map<string, RcaRuntime>();

  get(id = "demo") {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = new RcaRuntime(id);
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  list() {
    return [
      { id: "demo", title: "order-service 5xx 激增", time: "今天 10:24", status: "进行中" },
      { id: "payment-timeout", title: "payment-service 超时", time: "今天 09:12", status: "已完成" },
      { id: "checkout-failed", title: "用户下单失败", time: "昨天 16:08", status: "已完成" },
      { id: "db-connection", title: "数据库连接异常", time: "09-21 11:32", status: "已完成" },
      { id: "mq-backlog", title: "消息堆积告警", time: "09-20 14:15", status: "已归档" },
    ];
  }
}
