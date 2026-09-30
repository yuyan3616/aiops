package com.piops.management.domain.model;

import com.piops.management.domain.enums.TaskStatus;

import java.time.Instant;

/**
 * Spring 管理面拥有的 Task。
 *
 * 这里只描述“平台希望完成什么”，不复制 Agent Runtime 内部的 hypothesis/evidence/toolCall。
 */
public record ManagementTask(
        String taskId,
        String source,
        String sourceRef,
        String caseId,
        String title,
        TaskStatus status,
        String currentExecutionId,
        String idempotencyKey,
        Instant createdAt,
        Instant updatedAt
) {
}
