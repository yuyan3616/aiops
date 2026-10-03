package com.piops.management.repository;

import com.piops.management.domain.model.ManagementTask;

import java.util.Optional;

public interface TaskRepository {

    Optional<ManagementTask> findById(String taskId);

    Optional<ManagementTask> findByIdempotency(String source, String idempotencyKeyHash);

    ManagementTask insert(ManagementTask task);

    /**
     * 必须在事务中调用，用于串行化同一个 Task 的 Execution reservation。
     */
    ManagementTask lockById(String taskId);

    ManagementTask update(ManagementTask task);
}
