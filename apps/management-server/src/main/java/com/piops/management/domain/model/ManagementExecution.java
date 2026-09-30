package com.piops.management.domain.model;

import com.piops.management.domain.enums.ExecutionStatus;

import java.time.Instant;

/**
 * Task 的一次实际运行尝试。
 *
 * investigationId 只是引用 Node Runtime 中的调查，不代表 Spring 拥有 Investigation 数据。
 */
public record ManagementExecution(
        String executionId,
        String taskId,
        int attempt,
        String runtimeRequestId,
        String investigationId,
        ExecutionStatus status,
        String failureCode,
        String failureMessage,
        Instant startedAt,
        Instant finishedAt,
        Instant createdAt,
        Instant updatedAt
) {
}
