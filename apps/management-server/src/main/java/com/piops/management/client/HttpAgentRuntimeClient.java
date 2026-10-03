package com.piops.management.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.common.RequestIdContext;
import com.piops.management.config.AgentRuntimeProperties;
import com.piops.management.config.RequestIdFilter;
import com.piops.management.exception.RuntimeClientException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import java.util.Map;

/**
 * 基于 HTTP 的 Agent Runtime 客户端。
 *
 * 这里只负责协议适配、超时、鉴权和异常边界，不承载 RCA 业务逻辑。
 */
@Component
public class HttpAgentRuntimeClient implements AgentRuntimeClient {

    private static final String IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

    private final RestClient restClient;
    private final AgentRuntimeProperties properties;

    public HttpAgentRuntimeClient(AgentRuntimeProperties properties) {
        this.properties = properties;

        var requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());

        this.restClient = RestClient.builder()
                .baseUrl(properties.baseUrl())
                .requestFactory(requestFactory)
                .build();
    }

    @Override
    public RuntimeHealth health() {
        return execute(() -> withRequestId(restClient.get()
                .uri("/api/system/health"))
                .retrieve()
                .body(RuntimeHealth.class));
    }

    @Override
    public JsonNode getInvestigation(String investigationId) {
        return execute(() -> withRequestId(restClient.get()
                .uri("/api/rca/investigations/{investigationId}", investigationId))
                .retrieve()
                .body(JsonNode.class));
    }

    @Override
    public CancelInvestigationResult cancelInvestigation(String investigationId) {
        return execute(() -> withRequestId(restClient.post()
                .uri("/api/rca/investigations/{investigationId}/cancel", investigationId))
                .retrieve()
                .body(CancelInvestigationResult.class));
    }

    @Override
    public RuntimeExecution createExecution(String caseId, String idempotencyKey) {
        return execute(() -> withExecutionAuth(withRequestId(restClient.post()
                .uri("/api/rca/executions")
                .header(IDEMPOTENCY_KEY_HEADER, idempotencyKey)
                .body(Map.of("caseId", caseId))))
                .retrieve()
                .body(RuntimeExecution.class));
    }

    @Override
    public RuntimeExecution getExecution(String runtimeExecutionId) {
        return execute(() -> withExecutionAuth(withRequestId(restClient.get()
                .uri("/api/rca/executions/{runtimeExecutionId}", runtimeExecutionId)))
                .retrieve()
                .body(RuntimeExecution.class));
    }

    @Override
    public RuntimeExecution cancelExecution(String runtimeExecutionId) {
        return execute(() -> withExecutionAuth(withRequestId(restClient.post()
                .uri("/api/rca/executions/{runtimeExecutionId}/cancel", runtimeExecutionId)))
                .retrieve()
                .body(RuntimeExecution.class));
    }

    /**
     * 将管理面 Request ID 继续传给 Runtime，便于跨服务串联日志。
     * 没有请求上下文时（例如未来的后台任务）则不强行添加。
     */
    private RestClient.RequestHeadersSpec<?> withRequestId(RestClient.RequestHeadersSpec<?> request) {
        String requestId = RequestIdContext.get();
        if (requestId != null && !requestId.isBlank()) {
            request.header(RequestIdFilter.HEADER_NAME, requestId);
        }
        return request;
    }

    /**
     * Execution API 是有成本的写入口。token 缺失时明确拒绝，不退化成匿名请求。
     */
    private RestClient.RequestHeadersSpec<?> withExecutionAuth(RestClient.RequestHeadersSpec<?> request) {
        if (!properties.hasExecutionToken()) {
            throw new RuntimeClientException(
                    "AGENT_RUNTIME_EXECUTION_DISABLED",
                    "Agent runtime execution token is not configured",
                    HttpStatus.SERVICE_UNAVAILABLE
            );
        }
        request.header(HttpHeaders.AUTHORIZATION, "Bearer " + properties.executionToken());
        return request;
    }

    private <T> T execute(RuntimeCall<T> call) {
        try {
            T result = call.execute();
            if (result == null) {
                throw new RuntimeClientException(
                        "AGENT_RUNTIME_EMPTY_RESPONSE",
                        "Agent runtime returned an empty response",
                        HttpStatus.BAD_GATEWAY
                );
            }
            return result;
        } catch (RuntimeClientException error) {
            throw error;
        } catch (ResourceAccessException error) {
            // 超时不等于 Runtime 一定没有执行写请求，创建类接口必须依靠 Idempotency-Key 安全重放。
            throw new RuntimeClientException(
                    "AGENT_RUNTIME_UNAVAILABLE",
                    "Agent runtime is unavailable or timed out",
                    HttpStatus.SERVICE_UNAVAILABLE,
                    error
            );
        } catch (RestClientResponseException error) {
            throw new RuntimeClientException(
                    "AGENT_RUNTIME_ERROR",
                    "Agent runtime rejected the request with HTTP " + error.getStatusCode().value(),
                    HttpStatus.BAD_GATEWAY,
                    error
            );
        } catch (RuntimeException error) {
            throw new RuntimeClientException(
                    "AGENT_RUNTIME_ERROR",
                    "Agent runtime request failed",
                    HttpStatus.BAD_GATEWAY,
                    error
            );
        }
    }

    @FunctionalInterface
    private interface RuntimeCall<T> {
        T execute();
    }
}
