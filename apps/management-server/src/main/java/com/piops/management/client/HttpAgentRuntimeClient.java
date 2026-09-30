package com.piops.management.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.config.AgentRuntimeProperties;
import com.piops.management.exception.RuntimeClientException;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

@Component
public class HttpAgentRuntimeClient implements AgentRuntimeClient {

    private final RestClient restClient;

    public HttpAgentRuntimeClient(AgentRuntimeProperties properties) {
        var requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());

        this.restClient = RestClient.builder()
                .baseUrl(properties.baseUrl())
                .requestFactory(requestFactory)
                .build();
    }

    @Override
    public JsonNode getInvestigation(String investigationId) {
        return execute(() -> restClient.get()
                .uri("/api/rca/investigations/{investigationId}", investigationId)
                .retrieve()
                .body(JsonNode.class));
    }

    @Override
    public CancelInvestigationResult cancelInvestigation(String investigationId) {
        return execute(() -> restClient.post()
                .uri("/api/rca/investigations/{investigationId}/cancel", investigationId)
                .retrieve()
                .body(CancelInvestigationResult.class));
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
