import type { Rca100Task } from "./schema";

// Agent-facing metadata only. The telemetry files themselves are never bundled.
// Source: RCA100 v1.1, task t039.
export const T039_FALLBACK_TASK: Rca100Task = {
  task_id: "t039",
  task_version: "v1.1",
  alert_event_id: "bf976d5566cfca48c54c7bd3f998ce49",
  alert_title: "checkout响应时间突增告警",
  alert_trigger_time: "2026-04-28T09:20:55+08:00",
  alert_window: {
    start: "2026-04-28T09:18:30.931868+08:00",
    end: "2026-04-28T09:27:55+08:00",
  },
  alert_entity: {
    entity_id: "d219413245b68b297976412bbee076cf",
    entity_name: "checkout::/oteldemo.CheckoutService/PlaceOrder",
    entity_type: "apm.operation",
    entity_domain: "apm",
  },
  prompt_text:
    '<code vibeops_object type="alert_event">\n<alert_event event_id="f7dbb0c94e4a368dc6cff604663a0c64" trans_id="dt80od6ml90vp4v592nmta72b2" rule_id="cb77edf9-9b7a-4b67-b29f-bfd88e358742" rule_name="checkout响应时间突增告警" alert_time="2026-04-28T09:20:55+08:00" current_value="3355.241868578608" operation="/oteldemo.CheckoutService/PlaceOrder" service="checkout" service_id="<arms_svc_id>" workspace="rca-benchmark" region="cn-hongkong" entity_id="d219413245b68b297976412bbee076cf" entity_name="checkout::/oteldemo.CheckoutService/PlaceOrder" entity_type="apm.operation" entity_domain="apm" />\n</code> 帮我分析下根因。',
  workspace: "rca-benchmark",
  region_id: "cn-hongkong",
  available_modalities: ["metrics", "logs", "traces", "events", "alerts", "topology"],
  scoring_note: "Output contract (prediction_schema.json) and fault taxonomy (taxonomy.json) will be published in a follow-up release.",
  alert_trans_id: "dt80od6ml90vp4v592nmta72b2",
};
