import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Runtime Execution 是会产生 LLM 成本的写入口，必须单独鉴权。
 *
 * 比较时先做固定长度 hash，再使用 timingSafeEqual，避免直接字符串比较泄露前缀时序信息。
 */
export function verifyRuntimeExecutionToken(
  authorization: string | undefined,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken || configuredToken.length < 16) return false;
  if (!authorization?.startsWith("Bearer ")) return false;

  const provided = authorization.slice("Bearer ".length);
  if (!provided) return false;

  const expectedHash = createHash("sha256").update(configuredToken).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}
