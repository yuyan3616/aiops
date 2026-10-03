package com.piops.management.client;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Spring 管理面访问 Agent Runtime 的唯一抽象。
 *
 * Service 层只依赖这个接口，不感知 Hono、Pi SDK 或具体 HTTP 路径。
 * 未来即使 Runtime 通信方式切换为 RPC/MQ，也应优先保持上层接口稳定。
 */
public interface AgentRuntimeClient {

    RuntimeHealth health();

    JsonNode getInvestigation(String investigationId);

    CancelInvestigationResult cancelInvestigation(String investigationId);

    RuntimeExecution createExecution(String caseId, String idempotencyKey);

    RuntimeExecution getExecution(String runtimeExecutionId);

    RuntimeExecution cancelExecution(String runtimeExecutionId);

    record RuntimeHealth(String status) {
    }

    record CancelInvestigationResult(boolean cancelled) {
    }

    record RuntimeExecution(
            String runtimeExecutionId,
            String conversationId,
            String investigationId,
            String caseId,
            String status,
            Boolean replayed,
            String createdAt,
            String updatedAt,
            String lastError
    ) {
    }
}
