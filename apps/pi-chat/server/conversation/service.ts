import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  getSupportedThinkingLevels,
  type ImageContent,
  type TextContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";
import { settleBeforeDeadline } from "@server/observability/shutdown";
import {
  conversationRcaContextFromInvestigation,
  idleConversationRcaContext,
  type ConversationRcaContext,
  unavailableConversationRcaContext,
} from "@server/rca/conversation-context";
import { createRcaMainAgentTools } from "@server/rca/main-agent-tools";
import type { RcaService } from "@server/rca/service";
import type { Investigation } from "@server/rca/types";
import { hasSameStringItems } from "@server/utils";
import type {
  ConversationConfig,
  ConversationConfigUpdate,
  ConversationSnapshot,
  ConversationSummary,
  EventType,
  ModelOption,
  RuntimeStatus,
  SkillOption,
} from "@shared/types";

import { normalizePromptError, runDetached } from "./async-task";
import { EventChannel } from "./channel";
import { applyExternalStreamEvent, mergeMessageLists } from "./external-stream";
import { ConversationViewBuilder, extractImages, extractText, resultText } from "./helper";
import { reconcileRcaExecutionItems, settleInterruptedRcaSessionTools } from "./recovery";
import { ConversationRepository } from "./repository";
import { createRuntime } from "./runtime";
import {
  ConversationTitleGenerator,
  fallbackConversationTitle,
  type TitleModelRef,
} from "./title-generator";
import type { ConversationRecord, ConversationTitleMeta, ManagedSession } from "./types";

type PromptPerformancePurpose = "main_chat" | "steer";

interface PromptPerformanceTrace {
  id: string;
  purpose: PromptPerformancePurpose;
  startedAt: number;
  model: string;
  agentStarted: boolean;
  assistantStarted: boolean;
  firstModelDelta: boolean;
  firstTextDelta: boolean;
}

interface PendingTitleRefinement {
  input: {
    caseId: string;
    summary: string;
    rootCauseEntities: string[];
  };
  modelRef: TitleModelRef;
}

export class ConversationService {
  private globalConfig: GlobalConfig;
  private conversationRepository: ConversationRepository;
  private modelRuntime: ModelRuntime;
  private readonly rcaService: RcaService;
  private readonly titleGenerator: ConversationTitleGenerator;
  readonly ttlMs: number = 30_000;
  private readonly sessionIdleTtlMs = this.positiveDuration(
    process.env.PI_CHAT_SESSION_IDLE_TTL_MS,
    10 * 60_000,
  );
  private readonly sessionSweepIntervalMs = this.positiveDuration(
    process.env.PI_CHAT_SESSION_SWEEP_INTERVAL_MS,
    60_000,
  );
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly channels = new Map<string, EventChannel>();
  private readonly managedSessions = new Map<string, ManagedSession>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly recordWriteQueues = new Map<string, Promise<void>>();
  private readonly promptPerformance = new Map<string, PromptPerformanceTrace>();
  private readonly pendingTitleRefinements = new Map<string, PendingTitleRefinement>();
  private acceptingWork = true;
  private readonly pendingSends = new Set<Promise<unknown>>();

  constructor(globalConfig: GlobalConfig, modelRuntime: ModelRuntime, rcaService: RcaService) {
    this.globalConfig = globalConfig;
    this.modelRuntime = modelRuntime;
    this.conversationRepository = new ConversationRepository(globalConfig);
    this.rcaService = rcaService;
    this.titleGenerator = new ConversationTitleGenerator(modelRuntime);
    this.rcaService.subscribeVisualization((event) => {
      if (!event.conversationId) return;
      this.getEventChannel(event.conversationId).publish("visualization.updated", {
        investigationId: event.investigationId,
        status: event.status,
        updatedAt: event.updatedAt,
      });
    });
    this.sweepTimer = setInterval(() => {
      void this.sweepIdleSessions().catch((error) => {
        process.stderr.write(`Session sweep failed: ${String(error)}\n`);
      });
    }, this.sessionSweepIntervalMs);
    this.sweepTimer.unref();
  }

  close(): void {
    this.beginShutdown();
  }

  beginShutdown(): void {
    if (!this.acceptingWork) return;
    this.acceptingWork = false;
    clearInterval(this.sweepTimer);
  }

  async shutdown(timeoutMs = 10_000): Promise<{ timedOut: boolean; activeSessions: number }> {
    this.beginShutdown();
    let activeSessions = 0;
    const settle = (async () => {
      // Already admitted sends must finish initialization or reject before the snapshot.
      await Promise.allSettled([...this.pendingSends]);
      const busySessions = [...this.managedSessions.values()].filter((session) =>
        this.isRuntimeBusy(session),
      );
      activeSessions = busySessions.length;
      await Promise.allSettled(
        busySessions.map(async (managedSession) => {
          this.setStatus(managedSession, "stopping");
          try {
            await managedSession.runtime.session.abort();
          } finally {
            if (managedSession.status !== "error") this.setStatus(managedSession, "ready");
          }
        }),
      );
    })();
    const { timedOut } = await settleBeforeDeadline(settle, timeoutMs);

    for (const [id, managedSession] of [...this.managedSessions]) {
      if (!this.isBusy(managedSession)) this.release(id, { dropChannel: false });
    }

    return { timedOut, activeSessions };
  }

  private assertAcceptingWork(): void {
    if (!this.acceptingWork) {
      throw new Error("Server is shutting down and is not accepting new agent work.");
    }
  }

  private positiveDuration(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return raw !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  async createConversation() {
    this.assertAcceptingWork();
    const conversationId = randomUUID();
    const conversationWorkspaceDir = join(this.globalConfig.workspacesDir, conversationId);
    await mkdir(conversationWorkspaceDir, { recursive: true });

    const sessionManager = SessionManager.create(
      conversationWorkspaceDir,
      this.globalConfig.sessionsDir,
      {
        id: conversationId,
      },
    );

    const currentDate = new Date();
    const conversationRecord: ConversationRecord = {
      id: conversationId,
      title: "New Conversation",
      titleMeta: {
        source: "default",
        locked: false,
        generation: 0,
      },
      workspaceDir: conversationWorkspaceDir,
      sessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile()!,
      createdAt: currentDate,
      updatedAt: currentDate,
      selectedSkills: [],
    };
    await this.conversationRepository.save(conversationRecord);
    this.assertAcceptingWork();
    const managedSession = await this.createManagedSession(conversationRecord, sessionManager);
    if (!this.acceptingWork) {
      this.release(conversationId, { dropChannel: false });
      this.assertAcceptingWork();
    }
    return managedSession;
  }

  async send(conversationId: string, userInput: string, skills?: string[]) {
    this.assertAcceptingWork();
    const task = this.sendAccepted(conversationId, userInput, skills);
    this.pendingSends.add(task);
    try {
      return await task;
    } finally {
      this.pendingSends.delete(task);
    }
  }

  private async sendAccepted(conversationId: string, userInput: string, skills?: string[]) {
    const requestStartedAt = Date.now();
    const cleanedUserInput = userInput.trim();
    if (!cleanedUserInput || cleanedUserInput.length === 0) {
      throw new Error("User input cannot be empty.");
    }

    const loadSkillsResult = loadSkillsFromDir({
      dir: this.globalConfig.skillsDir,
      source: "project",
    });
    const availableSkillList = loadSkillsResult.skills.map((skill) => skill.name);
    const availableSkillsSet = new Set(availableSkillList);
    const validSelectedSkills = (skills ?? []).filter((skill) => availableSkillsSet.has(skill));

    const managedSession = await this.ensureManagedSession(conversationId, validSelectedSkills);
    const session = managedSession.runtime.session;
    let handedOff = false;
    try {
      // Keep the first-turn title deterministic. Starting a second LLM call here competes
      // with the user-facing prompt for the same provider and hurts time-to-first-token.
      await this.ensureFallbackTitle(conversationId, cleanedUserInput);

      this.assertAcceptingWork();
      const purpose: PromptPerformancePurpose = session.isStreaming ? "steer" : "main_chat";
      this.beginPromptPerformance(managedSession, purpose, requestStartedAt);

      if (session.isStreaming) {
        const investigationId = await this.resolveInvestigation(conversationId);
        const intervention = investigationId
          ? await this.rcaService.recordUserIntervention(investigationId, cleanedUserInput)
          : undefined;

        this.assertAcceptingWork();
        await session.prompt(cleanedUserInput, {
          streamingBehavior: "steer",
          source: "rpc",
        });

        if (investigationId && intervention) {
          this.rcaService.interruptActiveDispatch(investigationId);
        }
        return;
      }

      runDetached(
        async () => {
          try {
            this.assertAcceptingWork();
            await session.prompt(cleanedUserInput);
          } finally {
            this.done(managedSession);
          }
        },
        (cause) => {
          const message = normalizePromptError(cause);
          this.finishPromptPerformance(managedSession.id, "error", { error: message });
          managedSession.error = message;
          managedSession.streamMessageId = undefined;
          managedSession.streamThinkingId = undefined;
          managedSession.channel.publish("runtime.error", { error: message });
          this.setStatus(managedSession, "error");
          managedSession.channel.publish("runtime.settled", {});
        },
      );
      handedOff = true;
    } finally {
      if (!handedOff) this.done(managedSession);
    }
  }

  public async snapshot(id: string): Promise<ConversationSnapshot> {
    await this.waitForRecordWrites(id);
    const conversationRecord = await this.conversationRepository.get(id);
    if (!conversationRecord) {
      throw new Error(`Conversation with id ${id} not found.`);
    }
    const managedSession = await this.ensureManagedSession(id);
    try {
      const session = managedSession.runtime.session;
      const channel = managedSession.channel;

      const builder = new ConversationViewBuilder(session.sessionManager.getBranch());
      const investigations = await this.loadLinkedInvestigations(conversationRecord);
      const messageList = mergeMessageLists(
        settleInterruptedRcaSessionTools(builder.build(), investigations, session.isStreaming),
        reconcileRcaExecutionItems(conversationRecord.externalMessageList ?? [], investigations),
      );
      const rcaContext = await this.resolveRcaContext(id);

      return {
        conversation: this.summary(conversationRecord, managedSession.status),
        rca: {
          state: rcaContext.state,
          ...(rcaContext.investigationId ? { investigationId: rcaContext.investigationId } : {}),
          ...(rcaContext.caseId ? { caseId: rcaContext.caseId } : {}),
          ...(rcaContext.symptom ? { symptom: rcaContext.symptom } : {}),
          ...(rcaContext.rounds !== undefined ? { rounds: rcaContext.rounds } : {}),
          ...(rcaContext.rootCauseStatus ? { rootCauseStatus: rcaContext.rootCauseStatus } : {}),
        },
        messageList: messageList,
        activeSkillNames: [...managedSession.activeSkillNames],
        model: {
          provider: session.agent.state.model.provider,
          id: session.agent.state.model.id,
        },
        thinkingLevel: session.agent.state.thinkingLevel as ThinkingLevel,
        availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
        status: managedSession.status,
        error: managedSession.error,
        stream: {
          id: channel.streamId,
          lastEventId: channel.lastId,
        },
        diagnostics: managedSession.diagnostics,
      };
    } finally {
      this.done(managedSession);
    }
  }

  async list(): Promise<ConversationSummary[]> {
    const conversationRecords = await this.conversationRepository.list();
    return conversationRecords
      .map((record) => this.summary(record, this.managedSessions.get(record.id)?.status ?? "cold"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string) {
    await this.deleteMany([id]);
  }

  async deleteMany(ids: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(ids)];
    const records = (
      await Promise.all(uniqueIds.map((id) => this.conversationRepository.get(id)))
    ).filter((record) => record !== null);

    for (const record of records) {
      const managedSession = this.managedSessions.get(record.id);
      if (managedSession && this.isBusy(managedSession)) {
        throw new Error(`Cannot delete conversation ${record.id} because it is busy.`);
      }
    }

    for (const record of records) {
      await this.withSessionLock(record.id, async () => {
        const current = this.managedSessions.get(record.id);
        if (current && this.isBusy(current)) {
          throw new Error(`Cannot delete conversation ${record.id} because it is busy.`);
        }
        await this.waitForRecordWrites(record.id);
        this.release(record.id);
        if (existsSync(record.sessionFile)) await rm(record.sessionFile, { force: true });
        await rm(record.workspaceDir, { force: true, recursive: true });
        await this.conversationRepository.delete(record.id);
        this.channels.delete(record.id);
      });
    }

    return records.map((record) => record.id);
  }

  async persistExternalEvent(
    conversationId: string,
    type: EventType,
    payload: unknown,
  ): Promise<void> {
    await this.enqueueRecordWrite(conversationId, async () => {
      const record = await this.conversationRepository.get(conversationId);
      if (!record) throw new Error(`Conversation with ID ${conversationId} not found`);
      const next = applyExternalStreamEvent(
        record.externalMessageList ?? [],
        record.externalSequence ?? 0,
        type,
        payload,
      );
      await this.conversationRepository.update(conversationId, {
        externalMessageList: next.items,
        externalSequence: next.sequence,
      });
    });
  }

  async linkInvestigation(conversationId: string, investigationId: string): Promise<void> {
    await this.enqueueRecordWrite(conversationId, async () => {
      const record = await this.conversationRepository.get(conversationId);
      if (!record) throw new Error(`Conversation with ID ${conversationId} not found`);
      const investigationIds = [
        ...(record.investigationIds ?? []).filter((id) => id !== investigationId),
        investigationId,
      ];
      await this.conversationRepository.update(conversationId, {
        activeInvestigationId: investigationId,
        investigationIds,
      });
    });
  }

  async resolveInvestigation(
    conversationId: string,
    requestedInvestigationId?: string,
  ): Promise<string | undefined> {
    await this.waitForRecordWrites(conversationId);
    const record = await this.conversationRepository.get(conversationId);
    if (!record) throw new Error(`Conversation with ID ${conversationId} not found`);
    if (!requestedInvestigationId) return record.activeInvestigationId;
    return (record.investigationIds ?? []).includes(requestedInvestigationId)
      ? requestedInvestigationId
      : undefined;
  }

  public async rename(conversationId: string, title: string): Promise<ConversationSummary> {
    const cleanedTitle = title.trim();
    if (!cleanedTitle) throw Error("Title cannot be empty.");
    const current = await this.conversationRepository.get(conversationId);
    if (!current) throw new Error(`Conversation with ID ${conversationId} not found`);
    const newConversationRecord = await this.conversationRepository.update(conversationId, {
      title: cleanedTitle,
      titleMeta: {
        source: "user",
        locked: true,
        generation: this.titleMeta(current).generation,
      },
    });
    this.publishConversationTitle(newConversationRecord);
    return this.summary(
      newConversationRecord,
      this.managedSessions.get(conversationId)?.status ?? "cold",
    );
  }

  public async abort(conversationId: string) {
    const managedSession = await this.ensureManagedSession(conversationId);
    try {
      if (!this.isRuntimeBusy(managedSession)) return;
      this.setStatus(managedSession, "stopping");
      await managedSession.runtime.session.abort();
      this.setStatus(managedSession, "ready");
    } finally {
      this.done(managedSession);
    }
  }

  async getConfig(conversationId: string): Promise<ConversationConfig> {
    const managedSession = await this.ensureManagedSession(conversationId);
    try {
      return this.config(managedSession);
    } finally {
      this.done(managedSession);
    }
  }

  getAvailableModels(): ModelOption[] {
    return this.modelOptions();
  }

  getAvailableSkills(): SkillOption[] {
    const loadSkillsResult = loadSkillsFromDir({
      dir: this.globalConfig.skillsDir,
      source: "project",
    });
    return loadSkillsResult.skills.map((skill) => {
      return {
        name: skill.name,
        description: skill.description,
      };
    });
  }

  async updateConfig(
    conversationId: string,
    update: ConversationConfigUpdate,
  ): Promise<ConversationConfig> {
    const managedSession = await this.ensureManagedSession(conversationId);
    try {
      if (managedSession.activeUses > 1 || this.isRuntimeBusy(managedSession)) {
        throw new Error(
          `Cannot update config for conversation ${conversationId} because it is busy.`,
        );
      }

      const session = managedSession.runtime.session;
      if (update.model) {
        // session.setModel();
        const model = this.availableModels(managedSession).find(
          (item) => item.provider === update.model?.provider && item.id === update.model.id,
        );
        if (!model) {
          throw new Error(`Model ${update.model.provider}/${update.model.id} is not available.`);
        }
        await session.setModel(model);
      }

      if (update.thinkingLevel !== undefined) {
        if (!session.getAvailableThinkingLevels().includes(update.thinkingLevel as ThinkingLevel)) {
          throw new Error(`Thinking level ${update.thinkingLevel} is not available`);
        }
        session.setThinkingLevel(update.thinkingLevel);
      }

      return this.config(managedSession);
    } finally {
      this.done(managedSession);
    }
  }

  private config(managedSession: ManagedSession): ConversationConfig {
    const session = managedSession.runtime.session;
    return {
      model: {
        provider: session.agent.state.model.provider,
        id: session.agent.state.model.id,
      },
      models: this.modelOptions(managedSession),
      thinkingLevel: session.agent.state.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    };
  }

  private modelOptions(managedSession?: ManagedSession): ModelOption[] {
    const models = managedSession
      ? this.availableModels(managedSession)
      : this.modelRuntime.getAvailableSnapshot();
    return models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  }

  private async resolveRcaContext(conversationId: string): Promise<ConversationRcaContext> {
    await this.waitForRecordWrites(conversationId);
    const record = await this.conversationRepository.get(conversationId);
    if (!record?.activeInvestigationId) return idleConversationRcaContext();

    try {
      const investigation = await this.rcaService.get(record.activeInvestigationId);
      return conversationRcaContextFromInvestigation(investigation);
    } catch {
      return unavailableConversationRcaContext(record.activeInvestigationId);
    }
  }

  private async loadLinkedInvestigations(
    record: ConversationRecord,
  ): Promise<Map<string, Investigation>> {
    const investigationIds = new Set(record.investigationIds ?? []);
    if (record.activeInvestigationId) investigationIds.add(record.activeInvestigationId);

    const entries = await Promise.all(
      [...investigationIds].map(async (investigationId) => {
        try {
          return [investigationId, await this.rcaService.get(investigationId)] as const;
        } catch {
          return undefined;
        }
      }),
    );

    return new Map(
      entries.filter((entry): entry is readonly [string, Investigation] => entry !== undefined),
    );
  }

  private availableModels(managedSession: ManagedSession) {
    const scopedModels = managedSession.runtime.session.scopedModels;
    return scopedModels.length > 0
      ? scopedModels.map((item) => item.model)
      : this.modelRuntime.getAvailableSnapshot();
  }

  private summary(record: ConversationRecord, status: RuntimeStatus): ConversationSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      workspaceDir: record.workspaceDir,
      // ...(record.parentId ? { parentId: record.parentId } : {}),
      status,
    };
  }

  private async createManagedSession(
    conversationRecord: ConversationRecord,
    sessionManager: SessionManager,
    selectedSkills: string[] = [],
  ) {
    console.log("createManagedSession", selectedSkills);
    const getRcaContext = () => this.resolveRcaContext(conversationRecord.id);
    const rcaMainTools = createRcaMainAgentTools({
      rcaService: this.rcaService,
      conversationId: conversationRecord.id,
      getModelRef: () => {
        const managed = this.managedSessions.get(conversationRecord.id);
        if (managed) {
          return {
            provider: managed.runtime.session.agent.state.model.provider,
            id: managed.runtime.session.agent.state.model.id,
          };
        }
        const fallback = this.modelRuntime.getAvailableSnapshot()[0];
        if (!fallback) throw new Error("No model is available for RCA sub-agents");
        return { provider: fallback.provider, id: fallback.id };
      },
      onProjection: (projection) =>
        this.publishExternalEvent(conversationRecord.id, projection.type, projection.payload),
      onLinkInvestigation: (investigationId) =>
        this.linkInvestigation(conversationRecord.id, investigationId),
      getRcaContext,
      onConcluded: (investigation, report) => {
        const managed = this.managedSessions.get(conversationRecord.id);
        if (!managed || !investigation.rootCause) return;
        this.pendingTitleRefinements.set(conversationRecord.id, {
          input: {
            caseId: investigation.caseId,
            summary: investigation.rootCause.summary ?? report,
            rootCauseEntities: investigation.rootCause.rootCauseEntities ?? [],
          },
          modelRef: {
            provider: managed.runtime.session.agent.state.model.provider,
            id: managed.runtime.session.agent.state.model.id,
          },
        });
      },
    });

    const runtime = await createRuntime({
      globalConfig: this.globalConfig,
      conversationRecord,
      sessionManager,
      modelRuntime: this.modelRuntime,
      selectedSkills,
      customTools: rcaMainTools,
      getRcaContext,
    });

    const managedSession: ManagedSession = {
      id: conversationRecord.id,
      lastAccessAt: Date.now(),
      activeUses: 0,
      runtime,
      channel: this.getEventChannel(conversationRecord.id),
      status: runtime.session.isStreaming ? "running" : "ready",
      diagnostics: runtime.diagnostics.map((item) => item.message),
      activeSkillNames: [...selectedSkills],
    };
    this.managedSessions.set(managedSession.id, managedSession);
    try {
      this.bind(managedSession);
    } catch (error) {
      this.release(managedSession.id, { dropChannel: false });
      throw error;
    }
    return managedSession;
  }

  public getEventChannel(conversationId: string): EventChannel {
    let channel = this.channels.get(conversationId);
    if (!channel) {
      channel = new EventChannel();
      this.channels.set(conversationId, channel);
    }
    return channel;
  }

  private bind(managedSession: ManagedSession) {
    managedSession.unsubscribe?.();
    managedSession.unsubscribe = managedSession.runtime.session.subscribe((event) => {
      // Handle the event here
      switch (event.type) {
        case "agent_start":
          this.markPromptPerformance(managedSession.id, "agent_start");
          this.setStatus(managedSession, "running");
          break;
        case "message_start":
          const message = event.message;
          if (message.role === "assistant") {
            this.markPromptPerformance(managedSession.id, "assistant_message_start");
            managedSession.streamMessageId = randomUUID();
            managedSession.streamThinkingId = undefined;
            managedSession.channel.publish("message.started", {
              id: managedSession.streamMessageId,
            });
          } else if (message.role === "user") {
            const content: (TextContent | ImageContent)[] =
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content;
            const text = extractText(content);
            const images = extractImages(content);
            managedSession.channel.publish("message.added", {
              id: randomUUID(),
              role: message.role,
              text,
              images,
              timestamp: message.timestamp,
            });
          }
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            this.markPromptPerformance(managedSession.id, "first_model_delta");
            this.markPromptPerformance(managedSession.id, "first_text_delta");
            managedSession.channel.publish("message.delta", {
              id: managedSession.streamMessageId,
              delta: event.assistantMessageEvent.delta,
              timestamp: event.message.timestamp,
            });
          } else if (event.assistantMessageEvent.type === "thinking_start") {
            managedSession.streamThinkingId = randomUUID();
            managedSession.channel.publish("thinking.started", {
              id: managedSession.streamThinkingId,
            });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            this.markPromptPerformance(managedSession.id, "first_model_delta");
            managedSession.channel.publish("thinking.delta", {
              id: managedSession.streamThinkingId,
              delta: event.assistantMessageEvent.delta,
            });
          } else if (event.assistantMessageEvent.type === "thinking_end") {
            if (managedSession.streamThinkingId) {
              managedSession.channel.publish("thinking.completed", {
                id: managedSession.streamThinkingId,
              });
            }
          }
          break;
        case "message_end": {
          const message = event.message;
          if (message.role !== "assistant") break;

          const streamId = managedSession.streamMessageId ?? randomUUID();
          const text = extractText(message.content);
          const error =
            message.errorMessage || message.stopReason === "error"
              ? normalizePromptError(message.errorMessage)
              : undefined;

          if (text || error) {
            managedSession.channel.publish("message.completed", {
              streamId,
              message: {
                id: streamId,
                role: "assistant",
                text,
                images: [],
                timestamp: message.timestamp,
                ...(error ? { error } : {}),
              },
            });
          }

          if (error) {
            this.finishPromptPerformance(managedSession.id, "error", { error });
            managedSession.error = error;
            managedSession.channel.publish("runtime.error", { error });
            this.setStatus(managedSession, "error");
          }
          break;
        }
        case "entry_appended":
          break;
        case "tool_execution_start":
          managedSession.channel.publish("tool.started", {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_update":
          managedSession.channel.publish("tool.updated", {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            result: resultText(event.partialResult),
            details: event.partialResult, // todo
          });
          break;
        case "tool_execution_end":
          managedSession.channel.publish("tool.completed", {
            id: event.toolCallId,
            name: event.toolName,
            status: event.isError ? "error" : "success",
            result: resultText(event.result),
            details: event.result?.details,
          });
          break;
        case "agent_settled": {
          const failed = managedSession.status === "error";
          managedSession.streamMessageId = undefined;
          managedSession.streamThinkingId = undefined;
          if (!failed) {
            this.finishPromptPerformance(managedSession.id, "agent_settled");
            this.setStatus(managedSession, "ready");
            this.flushPendingTitleRefinement(managedSession);
          }
          managedSession.channel.publish("runtime.settled", {});
          break;
        }
        default:
          break;
      }
    });
  }

  private setStatus(managedSession: ManagedSession, status: RuntimeStatus) {
    managedSession.status = status;
    if (status !== "error") {
      managedSession.error = undefined;
    }
    managedSession.channel.publish("runtime.status", { status });
  }

  private async withSessionLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(id);
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.sessionLocks.set(id, current);
    if (previous) await previous;
    try {
      return await task();
    } finally {
      if (this.sessionLocks.get(id) === current) this.sessionLocks.delete(id);
      unlock();
    }
  }

  private acquire(managedSession: ManagedSession): ManagedSession {
    managedSession.activeUses++;
    managedSession.lastAccessAt = Date.now();
    return managedSession;
  }

  private done(managedSession: ManagedSession): void {
    managedSession.activeUses--;
    managedSession.lastAccessAt = Date.now();
    if (!this.acceptingWork && !this.isBusy(managedSession)) {
      this.release(managedSession.id, { dropChannel: false });
    }
  }

  private async ensureManagedSession(conversationId: string, selectedSkills?: string[]) {
    return this.withSessionLock(conversationId, async () =>
      this.acquire(await this.loadManagedSession(conversationId, selectedSkills)),
    );
  }

  private async loadManagedSession(conversationId: string, selectedSkills?: string[]) {
    let managedSession = this.managedSessions.get(conversationId);
    if (managedSession) {
      if (!selectedSkills || hasSameStringItems(managedSession.activeSkillNames, selectedSkills)) {
        return managedSession;
      }
      if (this.isBusy(managedSession)) {
        throw new Error(`Managed session is busy and cannot be updated with new selected skills.`);
      }
      // re-create managedsession

      const conversationRecord = await this.conversationRepository.get(conversationId);
      if (!conversationRecord) {
        throw new Error(`Conversation with ID ${conversationId} not found.`);
      }
      // pi sessionManager
      // eventChannel
      const sessionManager = managedSession.runtime.session.sessionManager;
      await this.conversationRepository.update(conversationId, { selectedSkills });
      this.release(conversationId, { dropChannel: false });
      return this.createManagedSession(
        { ...conversationRecord, selectedSkills },
        sessionManager,
        selectedSkills,
      );
    }
    const conversationRecord = await this.conversationRepository.get(conversationId);
    if (!conversationRecord) {
      throw new Error(`Conversation with ID ${conversationId} not found.`);
    }
    const restoredSessionFile = conversationRecord?.sessionFile;
    let sessionManager: SessionManager;
    if (existsSync(restoredSessionFile)) {
      sessionManager = SessionManager.open(
        restoredSessionFile,
        this.globalConfig.sessionsDir,
        conversationRecord.workspaceDir,
      );
    } else {
      sessionManager = SessionManager.create(
        conversationRecord.workspaceDir,
        this.globalConfig.sessionsDir,
        {
          id: conversationId,
        },
      );
    }

    return this.createManagedSession(
      conversationRecord,
      sessionManager,
      conversationRecord.selectedSkills,
    );
  }

  private titleMeta(record: ConversationRecord): ConversationTitleMeta {
    if (record.titleMeta) return record.titleMeta;
    if (record.title === "New Conversation" || record.title === "新会话") {
      return { source: "default", locked: false, generation: 0 };
    }
    return { source: "user", locked: true, generation: 0 };
  }

  private publishConversationTitle(record: ConversationRecord): void {
    this.getEventChannel(record.id).publish("conversation.updated", {
      conversation: this.summary(record, this.managedSessions.get(record.id)?.status ?? "cold"),
    });
  }

  private async ensureFallbackTitle(conversationId: string, userMessage: string): Promise<void> {
    const record = await this.conversationRepository.get(conversationId);
    if (!record) throw new Error(`Conversation with ID ${conversationId} not found`);
    const meta = this.titleMeta(record);
    if (meta.locked || meta.generation > 0) return;

    const updated = await this.conversationRepository.update(conversationId, {
      title: fallbackConversationTitle(userMessage),
      titleMeta: {
        source: "fallback",
        locked: false,
        generation: 1,
        generatedAt: new Date().toISOString(),
      },
    });
    this.publishConversationTitle(updated);
  }

  private beginPromptPerformance(
    managedSession: ManagedSession,
    purpose: PromptPerformancePurpose,
    startedAt: number,
  ): void {
    const trace: PromptPerformanceTrace = {
      id: randomUUID(),
      purpose,
      startedAt,
      model: `${managedSession.runtime.session.agent.state.model.provider}/${managedSession.runtime.session.agent.state.model.id}`,
      agentStarted: false,
      assistantStarted: false,
      firstModelDelta: false,
      firstTextDelta: false,
    };
    this.promptPerformance.set(managedSession.id, trace);
    this.writePerformanceLog({
      conversationId: managedSession.id,
      traceId: trace.id,
      purpose,
      stage: "request_received",
      elapsedMs: 0,
      model: trace.model,
    });
  }

  private markPromptPerformance(
    conversationId: string,
    stage: "agent_start" | "assistant_message_start" | "first_model_delta" | "first_text_delta",
  ): void {
    const trace = this.promptPerformance.get(conversationId);
    if (!trace) return;

    const alreadyMarked =
      (stage === "agent_start" && trace.agentStarted) ||
      (stage === "assistant_message_start" && trace.assistantStarted) ||
      (stage === "first_model_delta" && trace.firstModelDelta) ||
      (stage === "first_text_delta" && trace.firstTextDelta);
    if (alreadyMarked) return;

    if (stage === "agent_start") trace.agentStarted = true;
    if (stage === "assistant_message_start") trace.assistantStarted = true;
    if (stage === "first_model_delta") trace.firstModelDelta = true;
    if (stage === "first_text_delta") trace.firstTextDelta = true;

    this.writePerformanceLog({
      conversationId,
      traceId: trace.id,
      purpose: trace.purpose,
      stage,
      elapsedMs: Date.now() - trace.startedAt,
      model: trace.model,
    });
  }

  private finishPromptPerformance(
    conversationId: string,
    stage: "agent_settled" | "error",
    extra: Record<string, unknown> = {},
  ): void {
    const trace = this.promptPerformance.get(conversationId);
    if (!trace) return;
    this.promptPerformance.delete(conversationId);
    this.writePerformanceLog({
      conversationId,
      traceId: trace.id,
      purpose: trace.purpose,
      stage,
      elapsedMs: Date.now() - trace.startedAt,
      model: trace.model,
      ...extra,
    });
  }

  private writePerformanceLog(payload: Record<string, unknown>): void {
    process.stdout.write(`[chat.perf] ${JSON.stringify(payload)}\n`);
  }

  private flushPendingTitleRefinement(managedSession: ManagedSession): void {
    if (!this.acceptingWork) {
      this.pendingTitleRefinements.delete(managedSession.id);
      return;
    }
    const pending = this.pendingTitleRefinements.get(managedSession.id);
    if (!pending) return;
    this.pendingTitleRefinements.delete(managedSession.id);

    runDetached(
      async () => {
        const startedAt = Date.now();
        this.writePerformanceLog({
          conversationId: managedSession.id,
          purpose: "title_generation",
          stage: "start",
          elapsedMs: 0,
          model: `${pending.modelRef.provider}/${pending.modelRef.id}`,
        });
        try {
          await this.refineTitleAfterInvestigation(
            managedSession.id,
            pending.input,
            pending.modelRef,
          );
          this.writePerformanceLog({
            conversationId: managedSession.id,
            purpose: "title_generation",
            stage: "settled",
            elapsedMs: Date.now() - startedAt,
            model: `${pending.modelRef.provider}/${pending.modelRef.id}`,
          });
        } catch (error) {
          this.writePerformanceLog({
            conversationId: managedSession.id,
            purpose: "title_generation",
            stage: "error",
            elapsedMs: Date.now() - startedAt,
            model: `${pending.modelRef.provider}/${pending.modelRef.id}`,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      () => undefined,
    );
  }

  private async refineTitleAfterInvestigation(
    conversationId: string,
    input: {
      caseId: string;
      summary: string;
      rootCauseEntities: string[];
    },
    modelRef: TitleModelRef,
  ): Promise<void> {
    const record = await this.conversationRepository.get(conversationId);
    if (!record) return;
    const meta = this.titleMeta(record);
    if (meta.locked || meta.generation >= 2) return;

    const generated = await this.titleGenerator.generate(
      {
        userMessage: record.title,
        currentTitle: record.title,
        intent: "rca",
        caseId: input.caseId,
        investigationSummary: input.summary,
        rootCauseEntities: input.rootCauseEntities,
      },
      modelRef,
    );
    if (!generated) return;

    const latest = await this.conversationRepository.get(conversationId);
    if (!latest) return;
    const latestMeta = this.titleMeta(latest);
    if (latestMeta.locked || latestMeta.generation >= 2) return;

    const updated = await this.conversationRepository.update(conversationId, {
      title: generated,
      titleMeta: {
        source: "llm",
        locked: false,
        generation: 2,
        generatedAt: new Date().toISOString(),
      },
    });
    this.publishConversationTitle(updated);
  }

  private async publishExternalEvent(
    conversationId: string,
    type: EventType,
    payload: unknown,
  ): Promise<void> {
    this.getEventChannel(conversationId).publish(type, payload);
    await this.persistExternalEvent(conversationId, type, payload);
  }

  private enqueueRecordWrite(conversationId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.recordWriteQueues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    const tracked = next.finally(() => {
      if (this.recordWriteQueues.get(conversationId) === tracked) {
        this.recordWriteQueues.delete(conversationId);
      }
    });
    this.recordWriteQueues.set(conversationId, tracked);
    return tracked;
  }

  private async waitForRecordWrites(conversationId: string): Promise<void> {
    await this.recordWriteQueues.get(conversationId);
  }

  private isBusy(managedSession: ManagedSession): boolean {
    return managedSession.activeUses > 0 || this.isRuntimeBusy(managedSession);
  }

  private isRuntimeBusy(managedSession: ManagedSession): boolean {
    return (
      managedSession.runtime.session.isStreaming ||
      managedSession.runtime.session.agent.state.isStreaming ||
      managedSession.status === "running" ||
      managedSession.status === "stopping" ||
      managedSession.status === "compacting"
    );
  }

  private release(id: string, options: { dropChannel?: boolean } = {}) {
    const managedSession = this.managedSessions.get(id);
    if (!managedSession) return;
    try {
      managedSession.unsubscribe?.();
      managedSession.runtime.session.dispose();
    } finally {
      this.promptPerformance.delete(id);
      this.pendingTitleRefinements.delete(id);
      if (options.dropChannel ?? true) {
        this.channels.delete(id);
      }
      if (this.managedSessions.get(id) === managedSession) this.managedSessions.delete(id);
    }
  }

  private async sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, candidate] of this.managedSessions) {
      if (now - candidate.lastAccessAt < this.sessionIdleTtlMs || this.isBusy(candidate)) continue;
      await this.withSessionLock(id, async () => {
        if (
          this.managedSessions.get(id) !== candidate ||
          Date.now() - candidate.lastAccessAt < this.sessionIdleTtlMs ||
          this.isBusy(candidate)
        )
          return;
        this.release(id, { dropChannel: false });
        process.stdout.write(
          `[chat.session] ${JSON.stringify({ action: "evicted", conversationId: id })}\n`,
        );
      });
    }
  }
}
