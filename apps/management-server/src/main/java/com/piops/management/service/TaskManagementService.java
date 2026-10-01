package com.piops.management.service;

import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.service.TaskExecutionPersistenceService.CreateTaskCommand;
import org.springframework.stereotype.Service;

/**
 * Controller 面向的应用服务门面。
 *
 * Controller 不直接理解 Repository、事务或 Runtime 协议，只操作平台 Task 语义。
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

    public TaskSnapshot create(CreateTaskCommand command) {
        var task = persistenceService.createTaskIfAbsent(command);
        return snapshot(task);
    }

    public TaskSnapshot get(String taskId) {
        return snapshot(persistenceService.getTask(taskId));
    }

    public TaskSnapshot execute(String taskId) {
        var result = orchestrator.startOrResume(taskId);
        return new TaskSnapshot(result.task(), result.execution());
    }

    public TaskSnapshot sync(String taskId) {
        var result = orchestrator.sync(taskId);
        return new TaskSnapshot(result.task(), result.execution());
    }

    private TaskSnapshot snapshot(ManagementTask task) {
        ManagementExecution execution = null;
        if (task.currentExecutionId() != null) {
            execution = persistenceService.getExecution(task.currentExecutionId());
        }
        return new TaskSnapshot(task, execution);
    }

    public record TaskSnapshot(
            ManagementTask task,
            ManagementExecution execution
    ) {
    }
}
