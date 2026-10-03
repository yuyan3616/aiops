package com.piops.management.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "management-api")
public record ManagementApiProperties(String token) {

    public boolean enabled() {
        return token != null && token.length() >= 16;
    }
}
