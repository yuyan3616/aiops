package com.piops.management.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "agent-runtime")
public record AgentRuntimeProperties(
        String baseUrl,
        Duration connectTimeout,
        Duration readTimeout
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
}
