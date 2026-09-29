import type { PersonalModelInput } from "@shared/types";
import { useState } from "react";

export function PersonalModelDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose(): void;
  onSave(config: PersonalModelInput): void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  if (!open) return null;

  function save() {
    if (!baseUrl.trim() || !modelId.trim() || !apiKey.trim()) {
      setError("请填写 Base URL、模型 ID 和 API Key。");
      return;
    }
    try {
      if (new URL(baseUrl).protocol !== "https:") throw new Error();
    } catch {
      setError("Base URL 必须是有效的 HTTPS 地址。");
      return;
    }
    onSave({ baseUrl: baseUrl.trim(), modelId: modelId.trim(), apiKey: apiKey.trim() });
    setApiKey("");
    setError("");
  }

  return (
    <div
      className="personal-model-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="personal-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personal-model-title"
      >
        <button className="personal-model-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="personal-model-icon" aria-hidden="true">
          ⌘
        </div>
        <h2 id="personal-model-title">配置模型连接</h2>
        <p>当前会话可以使用你自己的 OpenAI Chat Completions 兼容模型。</p>
        <label htmlFor="personal-base-url">Base URL</label>
        <input
          id="personal-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.deepseek.com/v1"
          autoComplete="off"
          spellCheck={false}
        />
        <label htmlFor="personal-model-id">模型 ID</label>
        <input
          id="personal-model-id"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          placeholder="deepseek-chat"
          autoComplete="off"
          spellCheck={false}
        />
        <label htmlFor="personal-api-key">API Key</label>
        <input
          id="personal-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="请输入你的 API Key"
          autoComplete="new-password"
          spellCheck={false}
        />
        {error && (
          <span className="personal-model-error" role="alert">
            {error}
          </span>
        )}
        <div className="personal-model-privacy">
          本服务后端会临时使用此 Key 调用你选择的模型服务，包括主 Agent、专家 Agent 和标题生成。Key
          不写入会话记录；刷新页面或切换会话后需要重新填写。仅支持服务端批准的 HTTPS 模型地址。
        </div>
        <div className="personal-model-actions">
          <button type="button" onClick={onClose}>
            稍后配置
          </button>
          <button type="button" onClick={save}>
            保存到当前页面
          </button>
        </div>
      </div>
    </div>
  );
}
