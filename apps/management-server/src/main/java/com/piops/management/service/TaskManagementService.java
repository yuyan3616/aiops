package com.piops.management.service;

import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.service.TaskExecutionPersistenceService.CreateTaskCommand;
import com.piops.management.service.TaskExecutionPersistenceService.CreateTaskResult;
import org.springframework.stereotype.Service;

import java.time.Instant;

/**
 * Controller 面向的应用服务门面。
 *
 * API View 与 domain model 分离，避免把 idempotency hash、row version 等内部实现细节
 * 暴露到外部协议中。
 */
@Service
public class TaskManagementService {

    private final TaskExecutionPersistenceService persistenceService;
    private final TaskExecutionOrchestrator orchestrator;

    public TaskManagementService(
            TaskExecutionPersistenceService persistenceService,
            TaskExecutionOrchestrator orchestrator
    ) {
        this.persistenceService = persistenceService;
        this.orchestrator = orchestrator;
    }

    public TaskCreateResult create(CreateTaskCommand command) {
        CreateTaskResult result = persistenceService.createTaskIfAbsent(command);
        return new TaskCreateResult(snapshot(result.task()), result.replayed());
    }

    public TaskSnapshot get(String taskId) {
        return snapshot(persistenceService.getTask(taskId));
    }

    public TaskSnapshot execute(String taskId) {
        var result = orchestrator.startOrResume(taskId);
        return snapshot(result.task(), result.execution());
    }

    public TaskSnapshot sync(String taskId) {
        var result = orchestrator.sync(taskId);
        return snapshot(result.task(), result.execution());
    }

    private TaskSnapshot snapshot(ManagementTask task) {
        ManagementExecution execution = null;
        if (task.currentExecutionId() != null) {
            execution = persistenceService.getExecution(task.currentExecutionId());
        }
        return snapshot(task, execution);
    }

    private TaskSnapshot snapshot(
            ManagementTask task,
            ManagementExecution execution
    ) {
        return new TaskSnapshot(
                new TaskView(
                        task.taskId(),
                        task.source(),
                        task.sourceRef(),
                        task.caseId(),
                        task.title(),
                        task.status().name(),
                        task.currentExecutionId(),
                        task.createdAt(),
                        task.updatedAt()
                ),
                execution == null ? null : new ExecutionView(
                        execution.executionId(),
                        execution.attempt(),
                        execution.runtimeRequestId(),
                        execution.investigationId(),
                        execution.status().name(),
                        execution.failureCode(),
                        execution.failureMessage(),
                        execution.startedAt(),
                        execution.finishedAt(),
                        execution.createdAt(),
                        execution.updatedAt()
                )
        );
    }

    public record TaskView(
            String taskId,
            String source,
            String sourceRef,
            String caseId,
            String title,
            String status,
            String currentExecutionId,
            Instant createdAt,
            Instant updatedAt
    ) {
    }

    public record ExecutionView(
            String executionId,
            int attempt,
            String runtimeExecutionId,
            String investigationId,
            String status,
            String failureCode,
            String failureMessage,
            Instant startedAt,
            Instant finishedAt,
            Instant createdAt,
            Instant updatedAt
    ) {
    }

    public record TaskSnapshot(
            TaskView task,
            ExecutionView execution
    ) {
    }

    public record TaskCreateResult(
            TaskSnapshot snapshot,
            boolean replayed
    ) {
    }
}
