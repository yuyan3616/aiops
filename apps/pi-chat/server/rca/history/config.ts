import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RcaHistoryConfig {
  rootDir: string;
  investigationsDir: string;
  sessionsDir: string;
  workspacesDir: string;
}

export function getRcaHistoryConfig(rootDir = process.env.PI_CHAT_ROOT_DIR): RcaHistoryConfig {
  const piChatRoot = rootDir ?? join(getAgentDir(), "pi-chat");
  const rcaRoot = join(piChatRoot, "rca");
  return {
    rootDir: rcaRoot,
    investigationsDir: join(rcaRoot, "investigations"),
    sessionsDir: join(rcaRoot, "sessions"),
    workspacesDir: join(rcaRoot, "workspaces"),
  };
}

export async function ensureRcaHistoryDirs(config: RcaHistoryConfig) {
  await Promise.all([
    mkdir(config.rootDir, { recursive: true }),
    mkdir(config.investigationsDir, { recursive: true }),
    mkdir(config.sessionsDir, { recursive: true }),
    mkdir(config.workspacesDir, { recursive: true }),
  ]);
}
