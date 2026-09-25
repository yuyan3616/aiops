import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiSessionRef, RcaAgentRole } from "../../../shared/rca-types.ts";

import type { RcaHistoryConfig } from "./config.ts";

export class PersistentAgentSessionRegistry {
  private readonly managers = new Map<RcaAgentRole, SessionManager>();
  private readonly refs: Partial<Record<RcaAgentRole, PiSessionRef>>;

  constructor(
    private readonly config: RcaHistoryConfig,
    private readonly investigationId: string,
    refs: Partial<Record<RcaAgentRole, PiSessionRef>> = {},
  ) {
    this.refs = { ...refs };
  }

  references() {
    return structuredClone(this.refs);
  }

  async get(role: RcaAgentRole) {
    const existing = this.managers.get(role);
    if (existing) return existing;

    const workspaceDir = join(this.config.workspacesDir, this.investigationId, role);
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(this.config.sessionsDir, { recursive: true });

    const ref = this.refs[role];
    const manager = ref?.sessionFile && existsSync(ref.sessionFile)
      ? SessionManager.open(ref.sessionFile, this.config.sessionsDir, workspaceDir)
      : SessionManager.create(workspaceDir, this.config.sessionsDir, {
          id: `${this.investigationId}-${role}`,
        });

    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error(`Pi SessionManager did not create a session file for ${role}.`);
    }
    this.refs[role] = {
      sessionId: manager.getSessionId(),
      sessionFile,
    };
    this.managers.set(role, manager);
    return manager;
  }
}
