// Test adapter for domain operations, not a production tool registry or parameter schema.
import { createRcaMainHost, type RcaMainHostOptions } from "./main-host";
export function createRcaMainAgentTools(options: RcaMainHostOptions) {
  return Object.entries(createRcaMainHost(options)).filter(([name]) => name !== "utc_time").map(([name, execute]) => ({name, execute}));
}
