import { AbortableSemaphore } from "../semaphore";
import { LIVE_LIMITS, LiveBackendError, type LiveBackendErrorCode } from "./types";

type FetchLike = typeof fetch;

export interface LiveHttpClientOptions {
  baseUrl: string;
  backendAlias: string;
  headers?: Record<string, string>;
  deadlineMs?: number;
  maxBodyBytes?: number;
  maxConcurrency?: number;
  fetchImpl?: FetchLike;
}

export interface LiveHttpRequest {
  path: string;
  method?: "GET" | "POST";
  search?: URLSearchParams;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError("Request cancelled");
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError("Request cancelled during retry backoff"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 2_000));
}

function sanitizeMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/https?:\/\/[^\s]+/gi, "[backend]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

function mapStatus(status: number): { code: LiveBackendErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "unauthorized", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 400 || status === 422) return { code: "invalid_query", retryable: false };
  if (status === 502 || status === 503 || status === 504) {
    return { code: "unavailable", retryable: true };
  }
  return { code: "unavailable", retryable: status >= 500 };
}

export class LiveHttpClient {
  readonly backendAlias: string;
  private readonly baseUrl: URL;
  private readonly headers: Record<string, string>;
  private readonly deadlineMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly semaphore: AbortableSemaphore;

  constructor(options: LiveHttpClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.username || baseUrl.password) {
      throw new Error("Backend URL must not contain credentials");
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Backend URL must use http or https");
    }
    baseUrl.search = "";
    baseUrl.hash = "";
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
    this.baseUrl = baseUrl;
    this.backendAlias = options.backendAlias;
    this.headers = { ...(options.headers ?? {}) };
    this.deadlineMs = options.deadlineMs ?? LIVE_LIMITS.deadlineMs;
    this.maxBodyBytes = options.maxBodyBytes ?? LIVE_LIMITS.maxBackendBodyBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.semaphore = new AbortableSemaphore(options.maxConcurrency ?? 4);
  }

  async requestJson<T>(request: LiveHttpRequest): Promise<T> {
    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new LiveBackendError("invalid_query", "Backend path must be relative and absolute-path based", {
        backendAlias: this.backendAlias,
      });
    }
    const externalSignal = request.signal;
    if (externalSignal?.aborted) {
      throw new LiveBackendError("cancelled", "Backend request cancelled", {
        backendAlias: this.backendAlias,
      });
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort("deadline"), this.deadlineMs);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, deadline.signal])
      : deadline.signal;
    let release: (() => void) | undefined;
    try {
      release = await this.semaphore.acquire(signal);
      return await this.requestWithRetry<T>(request, signal, externalSignal, deadline);
    } catch (error) {
      if (error instanceof LiveBackendError) throw error;
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new LiveBackendError(
          externalSignal?.aborted ? "cancelled" : "timeout",
          externalSignal?.aborted ? "Backend request cancelled" : "Backend request deadline exceeded",
          { backendAlias: this.backendAlias, retryable: !externalSignal?.aborted, cause: error },
        );
      }
      const nodeCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      const retryable = /^(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)$/.test(nodeCode);
      throw new LiveBackendError("unavailable", sanitizeMessage(error), {
        backendAlias: this.backendAlias,
        retryable,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  private async requestWithRetry<T>(
    request: LiveHttpRequest,
    signal: AbortSignal,
    externalSignal: AbortSignal | undefined,
    deadline: AbortController,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      throwIfAborted(signal);
      try {
        return await this.requestOnce<T>(request, signal);
      } catch (error) {
        if (signal.aborted) {
          throw new LiveBackendError(
            externalSignal?.aborted ? "cancelled" : "timeout",
            externalSignal?.aborted ? "Backend request cancelled" : "Backend request deadline exceeded",
            { backendAlias: this.backendAlias, retryable: !externalSignal?.aborted, cause: error },
          );
        }
        if (!(error instanceof LiveBackendError) || !error.retryable || attempt >= 1) throw error;
        attempt++;
        const retryAfter =
          error.code === "rate_limited" && "retryAfterMs" in error
            ? Number((error as LiveBackendError & { retryAfterMs?: number }).retryAfterMs ?? 0)
            : 100;
        if (deadline.signal.aborted) throw error;
        await sleepAbortable(Math.max(0, Math.min(retryAfter, 2_000)), signal);
      }
    }
  }

  private async requestOnce<T>(request: LiveHttpRequest, signal: AbortSignal): Promise<T> {
    const url = new URL(request.path.slice(1), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new LiveBackendError("invalid_query", "Backend URL escaped configured origin", {
        backendAlias: this.backendAlias,
      });
    }
    if (request.search) url.search = request.search.toString();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...this.headers,
          ...(request.headers ?? {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      const nodeCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      throw new LiveBackendError("unavailable", sanitizeMessage(error), {
        backendAlias: this.backendAlias,
        retryable: /^(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)$/.test(nodeCode),
        cause: error,
      });
    }

    if (!response.ok) {
      const mapped = mapStatus(response.status);
      const error = new LiveBackendError(mapped.code, `${this.backendAlias} returned HTTP ${response.status}`, {
        backendAlias: this.backendAlias,
        status: response.status,
        retryable: mapped.retryable,
      }) as LiveBackendError & { retryAfterMs?: number };
      if (response.status === 429) error.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      try {
        await response.body?.cancel();
      } catch {
        // best-effort close only
      }
      throw error;
    }

    const bytes = await this.readBoundedBody(response, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new LiveBackendError("invalid_response", "Backend returned invalid JSON", {
        backendAlias: this.backendAlias,
        cause: error,
      });
    }
    return parsed as T;
  }

  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new LiveBackendError("invalid_response", "Backend response exceeds 4 MiB limit", {
        backendAlias: this.backendAlias,
      });
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const onAbort = () => {
      void reader.cancel("aborted").catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > this.maxBodyBytes) {
          await reader.cancel("body limit exceeded").catch(() => undefined);
          throw new LiveBackendError("invalid_response", "Backend response exceeds 4 MiB limit", {
            backendAlias: this.backendAlias,
          });
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        await reader.cancel("aborted").catch(() => undefined);
      }
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}
