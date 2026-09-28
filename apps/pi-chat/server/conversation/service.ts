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
import {
  ModelRuntime,
  SessionManager,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";
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

import { EventChannel } from "./channel";
import { applyExternalStreamEvent, mergeMessageLists } from "./external-stream";
import {
  reconcileRcaExecutionItems,
  settleInterruptedRcaSessionTools,
} from "./recovery";
import { ConversationViewBuilder, extractImages, extractText, resultText } from "./helper";
import { normalizePromptError, runDetached } from "./async-task";
import { ConversationRepository } from "./repository";
import { createRuntime } from "./runtime";
import {
  ConversationTitleGenerator,
  fallbackConversationTitle,
  type TitleModelRef,
} from "./title-generator";
import type { ConversationRecord, ConversationTitleMeta, ManagedSession } from "./types";

export class ConversationService {
  private globalConfig: GlobalConfig;
  private conversationRepository: ConversationRepository;
  private modelRuntime: ModelRuntime;
  private readonly rcaService: RcaService;
  private readonly titleGenerator: ConversationTitleGenerator;
  readonly ttlMs: number = 30_000;
  private readonly channels = new Map<string, EventChannel>();
  private readonly managedSessions = new Map<string, ManagedSession>();
  private readonly recordWriteQueues = new Map<string, Promise<void>>();

  constructor(globalConfig: GlobalConfig, modelRuntime: ModelRuntime, rcaService: RcaService) {
    this.globalConfig = globalConfig;
    this.modelRuntime = modelRuntime;
    this.conversationRepository = new ConversationRepository(globalConfig);
    this.rcaService = rcaService;
    this.titleGenerator = new ConversationTitleGenerator(modelRuntime);
  }

  async createConversation() {
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
    return this.createManagedSession(conversationRecord, sessionManager);
  }

  async send(conversationId: string, userInput: string, skills?: string[]) {
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
    const shouldGenerateTitle = await this.ensureFallbackTitle(conversationId, cleanedUserInput);
    if (shouldGenerateTitle) {
      const modelRef: TitleModelRef = {
        provider: session.agent.state.model.provider,
        id: session.agent.state.model.id,
      };
      runDetached(
        () => this.generateInitialTitle(conversationId, cleanedUserInput, modelRef),
        () => undefined,
      );
    }

    if (session.isStreaming) {
      const investigationId = await this.resolveInvestigation(conversationId);
      const intervention = investigationId
        ? await this.rcaService.recordUserIntervention(investigationId, cleanedUserInput)
        : undefined;

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
      () => session.prompt(cleanedUserInput),
      (cause) => {
        const message = normalizePromptError(cause);
        managedSession.error = message;
        managedSession.streamMessageId = undefined;
        managedSession.streamThinkingId = undefined;
        managedSession.channel.publish("runtime.error", { error: message });
        this.setStatus(managedSession, "error");
        managedSession.channel.publish("runtime.settled", {});
      },
    );
  }

  public async snapshot(id: string): Promise<ConversationSnapshot> {
    await this.waitForRecordWrites(id);
    const conversationRecord = await this.conversationRepository.get(id);
    if (!conversationRecord) {
      throw new Error(`Conversation with id ${id} not found.`);
    }
    const managedSession = await this.ensureManagedSession(id);
    const session = managedSession.runtime.session;
    const channel = managedSession.channel;

    const builder = new ConversationViewBuilder(session.sessionManager.getBranch());
    const investigations = await this.loadLinkedInvestigations(conversationRecord);
    const messageList = mergeMessageLists(
      settleInterruptedRcaSessionTools(builder.build(), investigations, session.isStreaming),
      reconcileRcaExecutionItems(
        conversationRecord.externalMessageList ?? [],
        investigations,
      ),
    );

    return {
      conversation: this.summary(conversationRecord, managedSession.status),
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
      await this.waitForRecordWrites(record.id);
      await this.release(record.id);

      if (existsSync(record.sessionFile)) {
        await rm(record.sessionFile, {
          force: true,
        });
      }

      await rm(record.workspaceDir, {
        force: true,
        recursive: true,
      });
      await this.conversationRepository.delete(record.id);
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
    if (!this.isBusy(managedSession)) return;
    this.setStatus(managedSession, "stopping");
    managedSession.runtime.session.abort();
    this.setStatus(managedSession, "ready");
  }

  async getConfig(conversationId: string): Promise<ConversationConfig> {
    const managedSession = await this.ensureManagedSession(conversationId);
    return this.config(managedSession);
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
    if (this.isBusy(managedSession)) {
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

  private async resolveRcaContext(
    conversationId: string,
  ): Promise<ConversationRcaContext> {
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
      entries.filter(
        (entry): entry is readonly [string, Investigation] => entry !== undefined,
      ),
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
        this.publishExternalEvent(
          conversationRecord.id,
          projection.type,
          projection.payload,
        ),
      onLinkInvestigation: (investigationId) =>
        this.linkInvestigation(conversationRecord.id, investigationId),
      getRcaContext,
      onConcluded: (investigation, report) => {
        const managed = this.managedSessions.get(conversationRecord.id);
        if (!managed || !investigation.rootCause) return;
        const modelRef: TitleModelRef = {
          provider: managed.runtime.session.agent.state.model.provider,
          id: managed.runtime.session.agent.state.model.id,
        };
        runDetached(
          () =>
            this.refineTitleAfterInvestigation(
              conversationRecord.id,
              {
                caseId: investigation.caseId,
                summary: investigation.rootCause?.summary ?? report,
                rootCauseEntities: investigation.rootCause?.rootCauseEntities ?? [],
              },
              modelRef,
            ),
          () => undefined,
        );
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
      runtime,
      channel: this.getEventChannel(conversationRecord.id),
      status: runtime.session.isStreaming ? "running" : "ready",
      diagnostics: runtime.diagnostics.map((item) => item.message),
      activeSkillNames: [...selectedSkills],
    };
    this.managedSessions.set(managedSession.id, managedSession);
    this.bind(managedSession);
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
          this.setStatus(managedSession, "running");
          break;
        case "message_start":
          const message = event.message;
          if (message.role === "assistant") {
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
        case "agent_settled":
          managedSession.streamMessageId = undefined;
          managedSession.streamThinkingId = undefined;
          this.setStatus(managedSession, "ready");
          managedSession.channel.publish("runtime.settled", {});
          break;
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

  private async ensureManagedSession(conversationId: string, selectedSkills?: string[]) {
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
      this.release(conversationId, { dropChannel: false });
      await this.conversationRepository.update(conversationId, { selectedSkills });
      return this.createManagedSession(conversationRecord, sessionManager, selectedSkills);
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
      conversation: this.summary(
        record,
        this.managedSessions.get(record.id)?.status ?? "cold",
      ),
    });
  }

  private async ensureFallbackTitle(
    conversationId: string,
    userMessage: string,
  ): Promise<boolean> {
    const record = await this.conversationRepository.get(conversationId);
    if (!record) throw new Error(`Conversation with ID ${conversationId} not found`);
    const meta = this.titleMeta(record);
    if (meta.locked || meta.generation > 0) return false;

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
    return true;
  }

  private async generateInitialTitle(
    conversationId: string,
    userMessage: string,
    modelRef: TitleModelRef,
  ): Promise<void> {
    const generated = await this.titleGenerator.generate({ userMessage }, modelRef);
    if (!generated) return;

    const record = await this.conversationRepository.get(conversationId);
    if (!record) return;
    const meta = this.titleMeta(record);
    if (meta.locked || meta.generation !== 1 || meta.source === "user") return;

    const updated = await this.conversationRepository.update(conversationId, {
      title: generated,
      titleMeta: {
        source: "llm",
        locked: false,
        generation: 1,
        generatedAt: new Date().toISOString(),
      },
    });
    this.publishConversationTitle(updated);
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
    return (
      managedSession.runtime.session.agent.state.isStreaming ||
      managedSession.status === "running" ||
      managedSession.status === "stopping" ||
      managedSession.status === "compacting"
    );
  }

  private async release(id: string, options: { dropChannel?: boolean } = {}) {
    const managedSession = this.managedSessions.get(id);
    if (!managedSession) return;
    managedSession.unsubscribe?.();
    managedSession.runtime.session.dispose();
    if (options.dropChannel ?? true) {
      this.channels.delete(id);
    }
    this.managedSessions.delete(id);
  }
}
