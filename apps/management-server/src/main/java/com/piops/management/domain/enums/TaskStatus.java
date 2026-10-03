package com.piops.management.domain.enums;

/**
 * 平台级任务状态。
 *
 * 注意：TaskStatus 是管理面聚合状态，不等同于 Node Runtime 中的 Investigation status。
 */
public enum TaskStatus {
    PENDING,
    RUNNING,
    SUCCEEDED,
    FAILED,
    CANCELLED
}
