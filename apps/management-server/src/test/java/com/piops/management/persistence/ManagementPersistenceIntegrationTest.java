package com.piops.management.persistence;

import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.enums.TaskStatus;
import com.piops.management.repository.ExecutionRepository;
import com.piops.management.repository.TaskRepository;
import com.piops.management.service.TaskExecutionPersistenceService;
import com.piops.management.service.TaskExecutionPersistenceService.CreateTaskCommand;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 使用真实 MySQL 验证 Flyway、MyBatis 映射和事务预留链路。
 *
 * 这个测试故意不 mock Repository，避免迁移 SQL 或字段映射错误只在部署后才暴露。
 */
@SpringBootTest
@Transactional
class ManagementPersistenceIntegrationTest {

    private final TaskExecutionPersistenceService service;
    private final TaskRepository taskRepository;
    private final ExecutionRepository executionRepository;

    ManagementPersistenceIntegrationTest(
            TaskExecutionPersistenceService service,
            TaskRepository taskRepository,
            ExecutionRepository executionRepository
    ) {
        this.service = service;
        this.taskRepository = taskRepository;
        this.executionRepository = executionRepository;
    }

    @Test
    void createsIdempotentTaskAndReservesSingleExecution() {
        var command = new CreateTaskCommand(
                "ci",
                "integration-1",
                "t039",
                "CI persistence smoke test",
                "ci-persistence-idempotency-001"
        );

        var firstTask = service.createTaskIfAbsent(command);
        var replayedTask = service.createTaskIfAbsent(command);

        assertThat(firstTask.taskId()).isEqualTo(replayedTask.taskId());
        assertThat(firstTask.status()).isEqualTo(TaskStatus.PENDING);
        assertThat(firstTask.idempotencyKeyHash()).hasSize(64);

        var firstExecution = service.reserveExecution(firstTask.taskId());
        var replayedExecution = service.reserveExecution(firstTask.taskId());

        assertThat(firstExecution.executionId()).isEqualTo(replayedExecution.executionId());
        assertThat(firstExecution.executionId()).startsWith("MEXEC-");
        assertThat(firstExecution.status()).isEqualTo(ExecutionStatus.CREATED);

        var storedTask = taskRepository.findById(firstTask.taskId()).orElseThrow();
        var storedExecution = executionRepository.findById(firstExecution.executionId()).orElseThrow();

        assertThat(storedTask.currentExecutionId()).isEqualTo(firstExecution.executionId());
        assertThat(storedTask.status()).isEqualTo(TaskStatus.RUNNING);
        assertThat(storedExecution.attempt()).isEqualTo(1);
    }
}
