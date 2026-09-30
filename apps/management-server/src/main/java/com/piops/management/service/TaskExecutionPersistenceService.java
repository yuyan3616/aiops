package com.piops.management.service;

import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.enums.TaskStatus;
import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.repository.ExecutionRepository;
import com.piops.management.repository.TaskRepository;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Task / Execution 的数据库事务边界。
 *
 * 这个类只负责“预留并持久化管理状态”，绝不能在 @Transactional 方法里调用 Node Runtime。
 * Runtime HTTP 调用由更上层的 orchestration service 在事务提交后执行。
 */
@Service
public class TaskExecutionPersistenceService {

    private static final Pattern SOURCE_PATTERN = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final Pattern CASE_ID_PATTERN = Pattern.compile("^t\\d{1,6}$");
    private static final Set<ExecutionStatus> ACTIVE_EXECUTION_STATUSES = Set.of(
            ExecutionStatus.CREATED,
            ExecutionStatus.DISPATCHING,
            ExecutionStatus.RUNNING,
            ExecutionStatus.UNKNOWN
    );

    private final TaskRepository taskRepository;
    private final ExecutionRepository executionRepository;

    public TaskExecutionPersistenceService(
            TaskRepository taskRepository,
            ExecutionRepository executionRepository
    ) {
        this.taskRepository = taskRepository;
        this.executionRepository = executionRepository;
    }

    /**
     * 基于 (source, idempotencyKeyHash) 唯一约束实现跨进程、跨重启幂等。
     * 原始 Idempotency-Key 只在本方法内参与 hash，不进入数据库。
     */
    @Transactional
    public ManagementTask createTaskIfAbsent(CreateTaskCommand command) {
        var normalized = normalize(command);
        var idempotencyHash = sha256(normalized.idempotencyKey());
        var now = Instant.now();

        var task = new ManagementTask(
                "TASK-" + UUID.randomUUID(),
                normalized.source(),
                normalized.sourceRef(),
                normalized.caseId(),
                normalized.title(),
                TaskStatus.PENDING,
                null,
                idempotencyHash,
                0L,
                now,
                now
        );

        try {
            return taskRepository.insert(task);
        } catch (DuplicateKeyException duplicate) {
            var existing = taskRepository
                    .findByIdempotency(normalized.source(), idempotencyHash)
                    .orElseThrow(() -> duplicate);

            // 同一个幂等键只能代表同一个逻辑任务，不能悄悄复用到另一个 case/sourceRef。
            if (!existing.caseId().equals(normalized.caseId())
                    || !Objects.equals(existing.sourceRef(), normalized.sourceRef())) {
                throw new IllegalStateException(
                        "Idempotency key is already bound to a different management task",
                        duplicate
                );
            }
            return existing;
        }
    }

    /**
     * 为 Task 预留一次 Execution。
     *
     * SELECT ... FOR UPDATE 保证同一个 Task 在单库多实例场景下也不会同时生成两个 attempt。
     * UNKNOWN 视为活动状态：结果不确定时必须先对账，不能直接创建下一次执行。
     */
    @Transactional
    public ManagementExecution reserveExecution(String taskId) {
        var task = taskRepository.lockById(requireId(taskId, "taskId"));

        if (task.status() == TaskStatus.SUCCEEDED || task.status() == TaskStatus.CANCELLED) {
            throw new IllegalStateException(
                    "Task " + task.taskId() + " is " + task.status() + " and cannot be executed again"
            );
        }

        if (task.currentExecutionId() != null) {
            var current = executionRepository.findById(task.currentExecutionId())
                    .orElseThrow(() -> new IllegalStateException(
                            "Task points to missing execution: " + task.currentExecutionId()
                    ));
            if (ACTIVE_EXECUTION_STATUSES.contains(current.status())) {
                return current;
            }
        }

        var now = Instant.now();
        var execution = new ManagementExecution(
                "MEXEC-" + UUID.randomUUID(),
                task.taskId(),
                executionRepository.nextAttempt(task.taskId()),
                null,
                null,
                ExecutionStatus.CREATED,
                null,
                null,
                null,
                null,
                0L,
                now,
                now
        );
        execution = executionRepository.insert(execution);

        taskRepository.update(new ManagementTask(
                task.taskId(),
                task.source(),
                task.sourceRef(),
                task.caseId(),
                task.title(),
                TaskStatus.RUNNING,
                execution.executionId(),
                task.idempotencyKeyHash(),
                task.version(),
                task.createdAt(),
                now
        ));

        return execution;
    }


    public ManagementTask getTask(String taskId) {
        return taskRepository.findById(requireId(taskId, "taskId"))
                .orElseThrow(() -> new IllegalArgumentException("Management task not found: " + taskId));
    }

    public ManagementExecution getExecution(String executionId) {
        return executionRepository.findById(requireId(executionId, "executionId"))
                .orElseThrow(() -> new IllegalArgumentException(
                        "Management execution not found: " + executionId
                ));
    }

    /**
     * Runtime 调用前提交 DISPATCHING 状态。该事务结束后才能真正发 HTTP 请求。
     */
    @Transactional
    public ManagementExecution markDispatching(String executionId) {
        var execution = executionRepository.lockById(requireId(executionId, "executionId"));
        var task = taskRepository.lockById(execution.taskId());
        assertCurrentExecution(task, execution);
        if (isTerminal(execution.status()) || execution.status() == ExecutionStatus.RUNNING) {
            return execution;
        }
        if (execution.status() != ExecutionStatus.CREATED
                && execution.status() != ExecutionStatus.DISPATCHING
                && execution.status() != ExecutionStatus.UNKNOWN) {
            throw new IllegalStateException(
                    "Execution " + execution.executionId() + " cannot dispatch from " + execution.status()
            );
        }

        var now = Instant.now();
        return executionRepository.update(new ManagementExecution(
                execution.executionId(),
                execution.taskId(),
                execution.attempt(),
                execution.runtimeRequestId(),
                execution.investigationId(),
                ExecutionStatus.DISPATCHING,
                null,
                null,
                execution.startedAt() == null ? now : execution.startedAt(),
                null,
                execution.version(),
                execution.createdAt(),
                now
        ));
    }

    /**
     * 将 Node Runtime 返回的状态绑定到当前 ManagementExecution。
     * 对 execution 和 task 都加行锁，避免状态同步与取消操作互相覆盖。
     */
    @Transactional
    public ManagementExecution applyRuntimeState(
            String executionId,
            RuntimeBinding binding
    ) {
        var execution = executionRepository.lockById(requireId(executionId, "executionId"));
        var task = taskRepository.lockById(execution.taskId());
        assertCurrentExecution(task, execution);

        if (isTerminal(execution.status())) {
            return execution;
        }
        if (!task.caseId().equals(binding.caseId())) {
            throw new IllegalStateException(
                    "Runtime execution case mismatch for " + execution.executionId()
            );
        }
        if (execution.runtimeRequestId() != null
                && !execution.runtimeRequestId().equals(binding.runtimeExecutionId())) {
            throw new IllegalStateException(
                    "Management execution is already bound to another runtime execution"
            );
        }

        var now = Instant.now();
        var terminal = isTerminal(binding.status());
        var updated = executionRepository.update(new ManagementExecution(
                execution.executionId(),
                execution.taskId(),
                execution.attempt(),
                binding.runtimeExecutionId(),
                binding.investigationId(),
                binding.status(),
                binding.failureCode(),
                truncate(binding.failureMessage(), 1024),
                execution.startedAt() == null ? now : execution.startedAt(),
                terminal ? now : null,
                execution.version(),
                execution.createdAt(),
                now
        ));

        taskRepository.update(new ManagementTask(
                task.taskId(),
                task.source(),
                task.sourceRef(),
                task.caseId(),
                task.title(),
                taskStatusFor(binding.status()),
                task.currentExecutionId(),
                task.idempotencyKeyHash(),
                task.version(),
                task.createdAt(),
                now
        ));
        return updated;
    }

    /**
     * 远程请求结果不确定时只标记 UNKNOWN，不创建新 attempt。
     * 同一个 MEXEC 后续会使用稳定幂等键向 Runtime 对账/重放。
     */
    @Transactional
    public ManagementExecution markUnknown(
            String executionId,
            String failureCode,
            String failureMessage
    ) {
        var execution = executionRepository.lockById(requireId(executionId, "executionId"));
        if (isTerminal(execution.status())) {
            return execution;
        }
        var task = taskRepository.lockById(execution.taskId());
        assertCurrentExecution(task, execution);
        var now = Instant.now();

        var updated = executionRepository.update(new ManagementExecution(
                execution.executionId(),
                execution.taskId(),
                execution.attempt(),
                execution.runtimeRequestId(),
                execution.investigationId(),
                ExecutionStatus.UNKNOWN,
                truncate(failureCode, 64),
                truncate(failureMessage, 1024),
                execution.startedAt() == null ? now : execution.startedAt(),
                null,
                execution.version(),
                execution.createdAt(),
                now
        ));

        taskRepository.update(new ManagementTask(
                task.taskId(),
                task.source(),
                task.sourceRef(),
                task.caseId(),
                task.title(),
                TaskStatus.RUNNING,
                task.currentExecutionId(),
                task.idempotencyKeyHash(),
                task.version(),
                task.createdAt(),
                now
        ));
        return updated;
    }

    /**
     * 只用于“确认请求尚未发出”的本地前置失败，例如 Runtime execution token 未配置。
     */
    @Transactional
    public ManagementExecution markFailedBeforeDispatch(
            String executionId,
            String failureCode,
            String failureMessage
    ) {
        var execution = executionRepository.lockById(requireId(executionId, "executionId"));
        if (isTerminal(execution.status())) {
            return execution;
        }
        var task = taskRepository.lockById(execution.taskId());
        assertCurrentExecution(task, execution);
        var now = Instant.now();

        var updated = executionRepository.update(new ManagementExecution(
                execution.executionId(),
                execution.taskId(),
                execution.attempt(),
                execution.runtimeRequestId(),
                execution.investigationId(),
                ExecutionStatus.FAILED,
                truncate(failureCode, 64),
                truncate(failureMessage, 1024),
                execution.startedAt(),
                now,
                execution.version(),
                execution.createdAt(),
                now
        ));

        taskRepository.update(new ManagementTask(
                task.taskId(),
                task.source(),
                task.sourceRef(),
                task.caseId(),
                task.title(),
                TaskStatus.FAILED,
                task.currentExecutionId(),
                task.idempotencyKeyHash(),
                task.version(),
                task.createdAt(),
                now
        ));
        return updated;
    }

    private void assertCurrentExecution(ManagementTask task, ManagementExecution execution) {
        if (!execution.executionId().equals(task.currentExecutionId())) {
            throw new IllegalStateException(
                    "Stale execution " + execution.executionId()
                            + " is not current for task " + task.taskId()
            );
        }
    }

    private TaskStatus taskStatusFor(ExecutionStatus status) {
        return switch (status) {
            case SUCCEEDED -> TaskStatus.SUCCEEDED;
            case FAILED -> TaskStatus.FAILED;
            case CANCELLED -> TaskStatus.CANCELLED;
            case CREATED, DISPATCHING, RUNNING, UNKNOWN -> TaskStatus.RUNNING;
        };
    }

    private boolean isTerminal(ExecutionStatus status) {
        return status == ExecutionStatus.SUCCEEDED
                || status == ExecutionStatus.FAILED
                || status == ExecutionStatus.CANCELLED;
    }

    private String truncate(String value, int maxLength) {
        if (value == null || value.length() <= maxLength) return value;
        return value.substring(0, maxLength);
    }

    private CreateTaskCommand normalize(CreateTaskCommand command) {
        if (command == null) {
            throw new IllegalArgumentException("command must not be null");
        }

        String source = requireText(command.source(), "source", 64);
        if (!SOURCE_PATTERN.matcher(source).matches()) {
            throw new IllegalArgumentException("source contains unsupported characters");
        }

        String caseId = requireText(command.caseId(), "caseId", 64).toLowerCase();
        if (!CASE_ID_PATTERN.matcher(caseId).matches()) {
            throw new IllegalArgumentException("caseId must match t<number>");
        }

        String sourceRef = nullableText(command.sourceRef(), "sourceRef", 255);
        String title = requireText(command.title(), "title", 255);
        String idempotencyKey = requireText(command.idempotencyKey(), "idempotencyKey", 256);
        if (idempotencyKey.length() < 8) {
            throw new IllegalArgumentException("idempotencyKey must contain at least 8 characters");
        }

        return new CreateTaskCommand(source, sourceRef, caseId, title, idempotencyKey);
    }

    private String requireId(String value, String field) {
        return requireText(value, field, 64);
    }

    private String requireText(String value, String field, int maxLength) {
        if (value == null) {
            throw new IllegalArgumentException(field + " must not be null");
        }
        String normalized = value.trim();
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        if (normalized.length() > maxLength) {
            throw new IllegalArgumentException(field + " exceeds max length " + maxLength);
        }
        return normalized;
    }

    private String nullableText(String value, String field, int maxLength) {
        if (value == null) return null;
        String normalized = value.trim();
        if (normalized.isEmpty()) return null;
        if (normalized.length() > maxLength) {
            throw new IllegalArgumentException(field + " exceeds max length " + maxLength);
        }
        return normalized;
    }

    private String sha256(String value) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public record CreateTaskCommand(
            String source,
            String sourceRef,
            String caseId,
            String title,
            String idempotencyKey
    ) {
    }

    public record RuntimeBinding(
            String runtimeExecutionId,
            String investigationId,
            String caseId,
            ExecutionStatus status,
            String failureCode,
            String failureMessage
    ) {
        public RuntimeBinding {
            if (runtimeExecutionId == null || runtimeExecutionId.isBlank()) {
                throw new IllegalArgumentException("runtimeExecutionId must not be blank");
            }
            if (caseId == null || caseId.isBlank()) {
                throw new IllegalArgumentException("caseId must not be blank");
            }
            Objects.requireNonNull(status, "status");
        }
    }
}
