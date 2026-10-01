package com.piops.management.service;

import com.piops.management.client.AgentRuntimeClient;
import com.piops.management.client.AgentRuntimeClient.RuntimeExecution;
import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.exception.RuntimeClientException;
import com.piops.management.service.TaskExecutionPersistenceService.RuntimeBinding;
import org.springframework.stereotype.Service;

/**
 * 管理面 Task 到 Node Runtime Execution 的跨服务编排层。
 *
 * 事务边界由 TaskExecutionPersistenceService 提供；本类本身不加 @Transactional，
 * 确保远程 HTTP 调用永远发生在数据库事务之外。
 */
@Service
public class TaskExecutionOrchestrator {

    private final TaskExecutionPersistenceService persistenceService;
    private final AgentRuntimeClient runtimeClient;

    public TaskExecutionOrchestrator(
            TaskExecutionPersistenceService persistenceService,
            AgentRuntimeClient runtimeClient
    ) {
        this.persistenceService = persistenceService;
        this.runtimeClient = runtimeClient;
    }

    public DispatchResult startOrResume(String taskId) {
        ManagementTask task = persistenceService.getTask(taskId);
        ManagementExecution execution = persistenceService.reserveExecution(taskId);

        if (isTerminal(execution.status())) {
            return new DispatchResult(task, execution);
        }

        if (execution.status() == ExecutionStatus.RUNNING && execution.runtimeRequestId() != null) {
            return syncKnownRuntime(task, execution);
        }

        execution = persistenceService.markDispatching(execution.executionId());
        if (isTerminal(execution.status())) {
            return new DispatchResult(persistenceService.getTask(taskId), execution);
        }

        try {
            RuntimeExecution runtime = runtimeClient.createExecution(
                    task.caseId(),
                    runtimeIdempotencyKey(execution.executionId())
            );
            ManagementExecution updated = persistenceService.applyRuntimeState(
                    execution.executionId(),
                    binding(runtime)
            );
            return new DispatchResult(persistenceService.getTask(taskId), updated);
        } catch (RuntimeClientException error) {
            if ("AGENT_RUNTIME_EXECUTION_DISABLED".equals(error.getCode())) {
                ManagementExecution failed = persistenceService.markFailedBeforeDispatch(
                        execution.executionId(),
                        error.getCode(),
                        error.getMessage()
                );
                return new DispatchResult(persistenceService.getTask(taskId), failed);
            }

            // 对已经尝试发出的远程请求，除非能证明请求没离开本进程，否则一律按 UNKNOWN 处理。
            ManagementExecution unknown = persistenceService.markUnknown(
                    execution.executionId(),
                    error.getCode(),
                    error.getMessage()
            );
            return new DispatchResult(persistenceService.getTask(taskId), unknown);
        }
    }

    public DispatchResult sync(String taskId) {
        ManagementTask task = persistenceService.getTask(taskId);
        if (task.currentExecutionId() == null) {
            return new DispatchResult(task, null);
        }

        ManagementExecution execution =
                persistenceService.getExecution(task.currentExecutionId());
        if (isTerminal(execution.status()) || execution.runtimeRequestId() == null) {
            return new DispatchResult(task, execution);
        }
        return syncKnownRuntime(task, execution);
    }

    /**
     * 取消必须以 Runtime 的真实状态为准，不能只改 MySQL。
     *
     * 对 DISPATCHING/UNKNOWN 且尚未拿到 runtimeExecutionId 的场景，
     * 使用稳定 Idempotency-Key 重放 create，以恢复/确认 Runtime Execution，
     * 再调用 cancel。这样不会留下“管理面已取消、Main Agent 仍在跑”的分叉状态。
     */
    public DispatchResult cancel(String taskId) {
        ManagementTask task = persistenceService.getTask(taskId);

        if (task.currentExecutionId() == null) {
            task = persistenceService.cancelTaskIfNotStarted(taskId);
            if (task.currentExecutionId() == null) {
                return new DispatchResult(task, null);
            }
        }

        ManagementExecution execution =
                persistenceService.getExecution(task.currentExecutionId());

        if (isTerminal(execution.status())) {
            return new DispatchResult(task, execution);
        }

        if (execution.status() == ExecutionStatus.CREATED) {
            execution = persistenceService.cancelBeforeDispatchIfCreated(execution.executionId());
            if (isTerminal(execution.status())) {
                return new DispatchResult(persistenceService.getTask(taskId), execution);
            }
        }

        try {
            String runtimeExecutionId = execution.runtimeRequestId();
            if (runtimeExecutionId == null) {
                RuntimeExecution recovered = runtimeClient.createExecution(
                        task.caseId(),
                        runtimeIdempotencyKey(execution.executionId())
                );
                runtimeExecutionId = recovered.runtimeExecutionId();

                // 先持久化恢复出的 Runtime 关联，随后即使 cancel 调用失败也能继续对账。
                execution = persistenceService.applyRuntimeState(
                        execution.executionId(),
                        binding(recovered)
                );

                if (isTerminal(execution.status())) {
                    return new DispatchResult(persistenceService.getTask(taskId), execution);
                }
            }

            RuntimeExecution cancelled = runtimeClient.cancelExecution(runtimeExecutionId);
            ManagementExecution updated = persistenceService.applyRuntimeState(
                    execution.executionId(),
                    binding(cancelled)
            );
            return new DispatchResult(persistenceService.getTask(taskId), updated);
        } catch (RuntimeClientException error) {
            ManagementExecution unknown = persistenceService.markUnknown(
                    execution.executionId(),
                    error.getCode(),
                    error.getMessage()
            );
            return new DispatchResult(persistenceService.getTask(taskId), unknown);
        }
    }

    private DispatchResult syncKnownRuntime(
            ManagementTask task,
            ManagementExecution execution
    ) {
        try {
            RuntimeExecution runtime = runtimeClient.getExecution(execution.runtimeRequestId());
            ManagementExecution updated = persistenceService.applyRuntimeState(
                    execution.executionId(),
                    binding(runtime)
            );
            return new DispatchResult(persistenceService.getTask(task.taskId()), updated);
        } catch (RuntimeClientException error) {
            ManagementExecution unknown = persistenceService.markUnknown(
                    execution.executionId(),
                    error.getCode(),
                    error.getMessage()
            );
            return new DispatchResult(persistenceService.getTask(task.taskId()), unknown);
        }
    }

    private RuntimeBinding binding(RuntimeExecution runtime) {
        return new RuntimeBinding(
                runtime.runtimeExecutionId(),
                runtime.investigationId(),
                runtime.caseId(),
                mapStatus(runtime.status()),
                failureCode(runtime),
                runtime.lastError()
        );
    }

    private ExecutionStatus mapStatus(String runtimeStatus) {
        return switch (runtimeStatus) {
            case "reserved", "dispatching" -> ExecutionStatus.DISPATCHING;
            case "running" -> ExecutionStatus.RUNNING;
            case "settled" -> ExecutionStatus.SUCCEEDED;
            case "failed" -> ExecutionStatus.FAILED;
            case "cancelled" -> ExecutionStatus.CANCELLED;
            case "unknown" -> ExecutionStatus.UNKNOWN;
            default -> ExecutionStatus.UNKNOWN;
        };
    }

    private String failureCode(RuntimeExecution runtime) {
        return switch (mapStatus(runtime.status())) {
            case FAILED -> "RUNTIME_FAILED";
            case UNKNOWN -> "RUNTIME_STATUS_UNKNOWN";
            default -> null;
        };
    }

    private String runtimeIdempotencyKey(String executionId) {
        // 不复用外部调用方的 Task Idempotency-Key，避免跨边界传播业务敏感标识。
        return "management:" + executionId;
    }

    private boolean isTerminal(ExecutionStatus status) {
        return status == ExecutionStatus.SUCCEEDED
                || status == ExecutionStatus.FAILED
                || status == ExecutionStatus.CANCELLED;
    }

    public record DispatchResult(
            ManagementTask task,
            ManagementExecution execution
    ) {
    }
}
