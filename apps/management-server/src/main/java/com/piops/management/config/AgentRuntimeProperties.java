package com.piops.management.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "agent-runtime")
public record AgentRuntimeProperties(
        String baseUrl,
        Duration connectTimeout,
        Duration readTimeout,
        String executionToken
) {
    public AgentRuntimeProperties {
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new IllegalArgumentException("agent-runtime.base-url must not be blank");
        }
        if (connectTimeout == null || connectTimeout.isNegative() || connectTimeout.isZero()) {
            throw new IllegalArgumentException("agent-runtime.connect-timeout must be positive");
        }
        if (readTimeout == null || readTimeout.isNegative() || readTimeout.isZero()) {
            throw new IllegalArgumentException("agent-runtime.read-timeout must be positive");
        }
    }

    /**
     * Execution API 会真实触发 Main Agent 和模型调用，因此 token 不允许硬编码默认值。
     * 未配置时管理服务仍可启动并使用只读能力，但创建/查询 Runtime Execution 会明确失败。
     */
    public boolean hasExecutionToken() {
        return executionToken != null && !executionToken.isBlank();
    }
}
