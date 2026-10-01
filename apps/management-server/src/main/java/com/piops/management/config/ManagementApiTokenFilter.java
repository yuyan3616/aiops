package com.piops.management.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.piops.management.common.ApiResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Task API 当前面向受信任的平台调用方，而不是浏览器最终用户。
 *
 * 在正式接入用户认证/RBAC 前，用独立 Bearer Token 保护所有 /tasks 写读入口。
 * 未配置 token 时 fail closed，避免生产环境因为漏配变量而匿名开放模型调用能力。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ManagementApiTokenFilter extends OncePerRequestFilter {

    private static final String TASK_PATH_PREFIX = "/api/management/tasks";

    private final ManagementApiProperties properties;
    private final ObjectMapper objectMapper;

    public ManagementApiTokenFilter(
            ManagementApiProperties properties,
            ObjectMapper objectMapper
    ) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith(TASK_PATH_PREFIX);
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        if (!properties.enabled()) {
            writeError(
                    response,
                    HttpServletResponse.SC_SERVICE_UNAVAILABLE,
                    "MANAGEMENT_API_DISABLED",
                    "Management task API token is not configured"
            );
            return;
        }

        String authorization = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (!isAuthorized(authorization)) {
            writeError(
                    response,
                    HttpServletResponse.SC_UNAUTHORIZED,
                    "UNAUTHORIZED",
                    "Invalid management API credentials"
            );
            return;
        }

        filterChain.doFilter(request, response);
    }

    private boolean isAuthorized(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            return false;
        }
        String provided = authorization.substring("Bearer ".length());
        if (provided.isBlank()) {
            return false;
        }

        return MessageDigest.isEqual(
                sha256(properties.token()),
                sha256(provided)
        );
    }

    private byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private void writeError(
            HttpServletResponse response,
            int status,
            String code,
            String message
    ) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        objectMapper.writeValue(
                response.getWriter(),
                ApiResponse.failure(code, message)
        );
    }
}
