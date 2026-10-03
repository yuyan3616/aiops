import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
/*
$HOME/.pi/agent/pi-chat
├── app-settings.json
├── exports
├── records
│   ├── 02583c3c-3baa-4285-917f-5218412322c2.json
├── sessions
│   ├── 2026-08-26T00-38-47-651Z_02583c3c-3baa-4285-917f-5218412322c2.jsonl
└── workspaces
    ├── 02583c3c-3baa-4285-917f-5218412322c2
    └── README.md
*/
export interface GlobalConfig {
  rootDir: string;
  recordsDir: string;
  sessionsDir: string;
  workspacesDir: string;
  mcpConfigPath: string;
  skillsDir: string;
  rcaInvestigationsDir: string;
}

export function getGlobalConfig(rootDir = process.env.PI_CHAT_ROOT_DIR): GlobalConfig {
  const resolvedRootDir = rootDir ?? join(getAgentDir(), "pi-chat");
  return {
    rootDir: resolvedRootDir,
    recordsDir: join(resolvedRootDir, "records"),
    sessionsDir: join(resolvedRootDir, "sessions"),
    workspacesDir: join(resolvedRootDir, "workspaces"),
    mcpConfigPath: join(resolvedRootDir, ".mcp.json"),
    skillsDir: join(resolvedRootDir, "skills"),
    rcaInvestigationsDir: resolve(
      process.env.RCA_INVESTIGATIONS_DIR ?? join(resolvedRootDir, "data", "rca", "investigations"),
    ),
  };
}

export async function ensureDir(paths: string[]) {
  return Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}
