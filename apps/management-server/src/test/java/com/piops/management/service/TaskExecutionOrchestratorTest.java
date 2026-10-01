package com.piops.management.service;

import com.piops.management.client.AgentRuntimeClient;
import com.piops.management.client.AgentRuntimeClient.RuntimeExecution;
import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.enums.TaskStatus;
import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.exception.RuntimeClientException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class TaskExecutionOrchestratorTest {

    private final TaskExecutionPersistenceService persistence = mock(TaskExecutionPersistenceService.class);
    private final AgentRuntimeClient runtime = mock(AgentRuntimeClient.class);
    private final TaskExecutionOrchestrator orchestrator =
            new TaskExecutionOrchestrator(persistence, runtime);

    @Test
    void usesManagementExecutionIdAsStableRuntimeIdempotencyKey() {
        var task = task(TaskStatus.RUNNING);
        var execution = execution(ExecutionStatus.CREATED, null);
        var dispatching = execution(ExecutionStatus.DISPATCHING, null);
        var running = execution(ExecutionStatus.RUNNING, "EXEC-runtime");

        when(persistence.getTask("TASK-1")).thenReturn(task);
        when(persistence.reserveExecution("TASK-1")).thenReturn(execution);
        when(persistence.markDispatching("MEXEC-1")).thenReturn(dispatching);
        when(runtime.createExecution("t039", "management:MEXEC-1"))
                .thenReturn(new RuntimeExecution(
                        "EXEC-runtime", "conversation-1", "INV-1", "t039",
                        "running", false, "now", "now", null
                ));
        when(persistence.applyRuntimeState(org.mockito.ArgumentMatchers.eq("MEXEC-1"), org.mockito.ArgumentMatchers.any()))
                .thenReturn(running);
        when(persistence.getTask("TASK-1")).thenReturn(task);

        var result = orchestrator.startOrResume("TASK-1");

        assertThat(result.execution().status()).isEqualTo(ExecutionStatus.RUNNING);
        verify(runtime).createExecution("t039", "management:MEXEC-1");
    }

    @Test
    void remoteTimeoutBecomesUnknownInsteadOfFailed() {
        var task = task(TaskStatus.RUNNING);
        var execution = execution(ExecutionStatus.CREATED, null);
        var dispatching = execution(ExecutionStatus.DISPATCHING, null);
        var unknown = execution(ExecutionStatus.UNKNOWN, null);

        when(persistence.getTask("TASK-1")).thenReturn(task);
        when(persistence.reserveExecution("TASK-1")).thenReturn(execution);
        when(persistence.markDispatching("MEXEC-1")).thenReturn(dispatching);
        when(runtime.createExecution("t039", "management:MEXEC-1"))
                .thenThrow(new RuntimeClientException(
                        "AGENT_RUNTIME_UNAVAILABLE",
                        "timeout",
                        HttpStatus.SERVICE_UNAVAILABLE
                ));
        when(persistence.markUnknown(
                "MEXEC-1",
                "AGENT_RUNTIME_UNAVAILABLE",
                "timeout"
        )).thenReturn(unknown);
        when(persistence.getTask("TASK-1")).thenReturn(task);

        var result = orchestrator.startOrResume("TASK-1");

        assertThat(result.execution().status()).isEqualTo(ExecutionStatus.UNKNOWN);
    }


    @Test
    void cancelPendingTaskDoesNotTouchRuntime() {
        var pending = taskWithoutExecution(TaskStatus.PENDING);
        var cancelled = taskWithoutExecution(TaskStatus.CANCELLED);

        when(persistence.getTask("TASK-1")).thenReturn(pending);
        when(persistence.cancelTaskIfNotStarted("TASK-1")).thenReturn(cancelled);

        var result = orchestrator.cancel("TASK-1");

        assertThat(result.task().status()).isEqualTo(TaskStatus.CANCELLED);
        assertThat(result.execution()).isNull();
        verifyNoInteractions(runtime);
    }

    @Test
    void cancelCreatedExecutionStopsLocallyBeforeRuntimeDispatch() {
        var runningTask = task(TaskStatus.RUNNING);
        var cancelledTask = task(TaskStatus.CANCELLED);
        var created = execution(ExecutionStatus.CREATED, null);
        var cancelled = execution(ExecutionStatus.CANCELLED, null);

        when(persistence.getTask("TASK-1")).thenReturn(runningTask, cancelledTask);
        when(persistence.getExecution("MEXEC-1")).thenReturn(created);
        when(persistence.cancelBeforeDispatchIfCreated("MEXEC-1")).thenReturn(cancelled);

        var result = orchestrator.cancel("TASK-1");

        assertThat(result.execution().status()).isEqualTo(ExecutionStatus.CANCELLED);
        verifyNoInteractions(runtime);
    }

    @Test
    void cancelUnknownExecutionRecoversRuntimeIdempotentlyBeforeCancelling() {
        var runningTask = task(TaskStatus.RUNNING);
        var cancelledTask = task(TaskStatus.CANCELLED);
        var unknown = execution(ExecutionStatus.UNKNOWN, null);
        var recovered = execution(ExecutionStatus.RUNNING, "EXEC-runtime");
        var cancelled = execution(ExecutionStatus.CANCELLED, "EXEC-runtime");

        var runtimeRunning = new RuntimeExecution(
                "EXEC-runtime", "conversation-1", "INV-1", "t039",
                "running", true, "now", "now", null
        );
        var runtimeCancelled = new RuntimeExecution(
                "EXEC-runtime", "conversation-1", "INV-1", "t039",
                "cancelled", true, "now", "now", null
        );

        when(persistence.getTask("TASK-1")).thenReturn(runningTask, cancelledTask);
        when(persistence.getExecution("MEXEC-1")).thenReturn(unknown);
        when(runtime.createExecution("t039", "management:MEXEC-1")).thenReturn(runtimeRunning);
        when(persistence.applyRuntimeState(
                org.mockito.ArgumentMatchers.eq("MEXEC-1"),
                org.mockito.ArgumentMatchers.any()
        )).thenReturn(recovered, cancelled);
        when(runtime.cancelExecution("EXEC-runtime")).thenReturn(runtimeCancelled);

        var result = orchestrator.cancel("TASK-1");

        assertThat(result.execution().status()).isEqualTo(ExecutionStatus.CANCELLED);
        verify(runtime).createExecution("t039", "management:MEXEC-1");
        verify(runtime).cancelExecution("EXEC-runtime");
    }

    private ManagementTask task(TaskStatus status) {
        var now = Instant.now();
        return new ManagementTask(
                "TASK-1", "ci", "ref", "t039", "title", status,
                "MEXEC-1", "hash", 1L, now, now
        );
    }

    private ManagementTask taskWithoutExecution(TaskStatus status) {
        var now = Instant.now();
        return new ManagementTask(
                "TASK-1", "ci", "ref", "t039", "title", status,
                null, "hash", 1L, now, now
        );
    }

    private ManagementExecution execution(ExecutionStatus status, String runtimeId) {
        var now = Instant.now();
        return new ManagementExecution(
                "MEXEC-1", "TASK-1", 1, runtimeId, null, status,
                null, null, now, null, 1L, now, now
        );
    }
}
