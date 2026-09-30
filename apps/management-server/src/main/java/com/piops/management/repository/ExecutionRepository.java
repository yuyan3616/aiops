package com.piops.management.repository;

import com.piops.management.domain.model.ManagementExecution;

import java.util.Optional;

public interface ExecutionRepository {

    Optional<ManagementExecution> findById(String executionId);

    Optional<ManagementExecution> findLatestByTaskId(String taskId);

    int nextAttempt(String taskId);

    ManagementExecution insert(ManagementExecution execution);

    ManagementExecution update(ManagementExecution execution);
}
