package com.piops.management.service;

import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.enums.TaskStatus;
import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.repository.ExecutionRepository;
import com.piops.management.repository.TaskRepository;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskExecutionPersistenceServiceTest {

    private final TaskRepository taskRepository = mock(TaskRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final TaskExecutionPersistenceService service =
            new TaskExecutionPersistenceService(taskRepository, executionRepository);

    @Test
    void reserveExecutionReusesUnknownExecutionInsteadOfRetrying() {
        var now = Instant.now();
        var task = new ManagementTask(
                "TASK-1", "alertmanager", "alert-1", "t039", "checkout latency",
                TaskStatus.RUNNING, "MEXEC-1", "hash", 2L, now, now
        );
        var execution = new ManagementExecution(
                "MEXEC-1", "TASK-1", 1, "EXEC-runtime", null,
                ExecutionStatus.UNKNOWN, null, null, now, null, 3L, now, now
        );
        when(taskRepository.lockById("TASK-1")).thenReturn(task);
        when(executionRepository.findById("MEXEC-1")).thenReturn(Optional.of(execution));

        var result = service.reserveExecution("TASK-1");

        assertThat(result.executionId()).isEqualTo("MEXEC-1");
        verify(taskRepository).lockById("TASK-1");
    }

    @Test
    void reserveExecutionCreatesNextAttemptAfterFailedExecution() {
        var now = Instant.now();
        var task = new ManagementTask(
                "TASK-1", "alertmanager", "alert-1", "t039", "checkout latency",
                TaskStatus.FAILED, "MEXEC-1", "hash", 2L, now, now
        );
        var failed = new ManagementExecution(
                "MEXEC-1", "TASK-1", 1, "EXEC-runtime", "INV-1",
                ExecutionStatus.FAILED, "RUNTIME_ERROR", "failed", now, now, 3L, now, now
        );
        when(taskRepository.lockById("TASK-1")).thenReturn(task);
        when(executionRepository.findById("MEXEC-1")).thenReturn(Optional.of(failed));
        when(executionRepository.nextAttempt("TASK-1")).thenReturn(2);
        when(executionRepository.insert(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(taskRepository.update(any())).thenAnswer(invocation -> invocation.getArgument(0));

        var result = service.reserveExecution("TASK-1");

        assertThat(result.attempt()).isEqualTo(2);
        assertThat(result.status()).isEqualTo(ExecutionStatus.CREATED);
        assertThat(result.executionId()).startsWith("MEXEC-");
    }
}
