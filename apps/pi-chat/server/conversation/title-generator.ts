import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const TITLE_SYSTEM_PROMPT = `You generate concise conversation titles.

Return JSON only: {"title":"..."}.

Rules:
- Use the language used by the user.
- Describe the task, not the user.
- If a case id such as t039 is present, preserve it exactly.
- Do not state an unconfirmed hypothesis as fact.
- Chinese titles should usually be 6-16 Chinese characters excluding a case id.
- English titles should usually be 3-8 words.
- No quotes, markdown, trailing punctuation, or meta phrases such as "用户想要".
- Never include secrets, URLs, stack traces, or long verbatim prompts.`;

export interface TitleGenerationInput {
  userMessage: string;
  currentTitle?: string;
  intent?: string;
  caseId?: string;
  investigationSummary?: string;
  rootCauseEntities?: string[];
}

export interface TitleModelRef {
  provider: string;
  id: string;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function findCaseId(value: string): string | undefined {
  return value.match(/\bt\d+\b/i)?.[0]?.toLowerCase();
}

export function sanitizeGeneratedTitle(value: string): string | undefined {
  const title = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/[。.!！?？:：;,，；]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title || title.length > 40) return undefined;
  if (/https?:\/\//i.test(title)) return undefined;
  if (/^(用户|user)\s*(想要|asks?|wants?)/i.test(title)) return undefined;
  return title;
}

export function fallbackConversationTitle(userMessage: string): string {
  const cleaned = userMessage
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[`*_>#~[\]{}()]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const caseId = findCaseId(cleaned);
  const rcaIntent =
    /(?:排查|定位|诊断|根因|故障|异常|延迟|变慢)|(?:investigate|diagnose|root\s*cause|incident|latency)/i.test(
      cleaned,
    );

  if (caseId && rcaIntent) {
    return containsCjk(cleaned) ? `${caseId} 根因排查` : `${caseId} RCA investigation`;
  }

  if (!cleaned) return "新会话";
  if (containsCjk(cleaned)) {
    const compact = cleaned
      .replace(/[，。！？、；：,.!?;:]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .join(" ");
    return compact.slice(0, 18) || "新会话";
  }

  const words = cleaned
    .replace(/[^a-zA-Z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  return words.join(" ").slice(0, 40) || "New Conversation";
}

export class ConversationTitleGenerator {
  private readonly modelRuntime: ModelRuntime;

  constructor(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  async generate(
    input: TitleGenerationInput,
    modelRef?: TitleModelRef,
  ): Promise<string | undefined> {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => TITLE_SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    const model = modelRef
      ? this.modelRuntime.getModel(modelRef.provider, modelRef.id)
      : undefined;
    if (modelRef && !model) return undefined;

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime: this.modelRuntime,
      ...(model ? { model } : {}),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });

    let output = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(
        `Generate a title for this conversation context:\n\n${JSON.stringify(input, null, 2)}`,
      );
    } finally {
      unsubscribe();
      session.dispose();
    }

    const json = output.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return undefined;
    try {
      const parsed = JSON.parse(json) as { title?: unknown };
      return typeof parsed.title === "string" ? sanitizeGeneratedTitle(parsed.title) : undefined;
    } catch {
      return undefined;
    }
  }
}
