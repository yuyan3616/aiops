const NO_API_KEY_MESSAGE =
  "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。";
const DEFAULT_PROMPT_ERROR_MESSAGE = "模型调用失败，请稍后重试。";

export function normalizePromptError(cause: unknown): string {
  const rawMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : String(cause ?? "");
  const message = rawMessage.trim();

  if (/no api key found for the selected model/i.test(message)) {
    return NO_API_KEY_MESSAGE;
  }
  return message || DEFAULT_PROMPT_ERROR_MESSAGE;
}

export function runDetached(
  task: () => unknown | Promise<unknown>,
  onError: (cause: unknown) => void | Promise<void>,
): void {
  void Promise.resolve()
    .then(task)
    .catch(async (cause: unknown) => {
      try {
        await onError(cause);
      } catch (handlerError) {
        const message =
          handlerError instanceof Error
            ? handlerError.stack ?? handlerError.message
            : String(handlerError);
        process.stderr.write(`Detached task error handler failed: ${message}\n`);
      }
    });
}
