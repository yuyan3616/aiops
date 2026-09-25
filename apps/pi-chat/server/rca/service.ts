import { RcaRuntime } from "./runtime";

export class RcaService {
  private readonly runtimes = new Map<string, RcaRuntime>();

  get(id = "demo") {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = new RcaRuntime(id, "t039");
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  list() {
    return [
      { id: "demo", title: "RCA100 · t039 · checkout响应时间突增", time: "推荐示例", status: "数据集案例" },
      { id: "payment-timeout", title: "payment-service 超时", time: "演示历史", status: "已完成" },
      { id: "checkout-failed", title: "用户下单失败", time: "演示历史", status: "已完成" },
    ];
  }
}
