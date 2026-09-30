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
}
