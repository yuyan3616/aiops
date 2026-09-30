package com.piops.management.domain.mapper;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.domain.enums.ExecutionStatus;
import org.springframework.stereotype.Component;

/**
 * 将 Runtime Investigation 的只读状态映射为管理面 ExecutionStatus。
 *
 * 这里的映射只能帮助 Spring 展示/治理，绝不能反向改写 Runtime Investigation。
 */
@Component
public class InvestigationExecutionStatusMapper {

    public ExecutionStatus map(JsonNode investigation) {
        String status = investigation.path("status").asText("");

        return switch (status) {
            case "running" -> ExecutionStatus.RUNNING;
            case "cancelled" -> ExecutionStatus.CANCELLED;
            case "completed" -> ExecutionStatus.SUCCEEDED;
            case "interrupted" -> ExecutionStatus.FAILED;
            default -> ExecutionStatus.UNKNOWN;
        };
    }
}
