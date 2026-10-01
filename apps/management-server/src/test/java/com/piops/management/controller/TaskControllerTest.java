package com.piops.management.controller;

import com.piops.management.exception.GlobalExceptionHandler;
import com.piops.management.service.TaskManagementService;
import com.piops.management.service.TaskManagementService.TaskCreateResult;
import com.piops.management.service.TaskManagementService.TaskSnapshot;
import com.piops.management.service.TaskManagementService.TaskView;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class TaskControllerTest {

    private final TaskManagementService service = mock(TaskManagementService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new TaskController(service))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();

    @Test
    void createReturns201ForFirstCreation() throws Exception {
        when(service.create(any())).thenReturn(new TaskCreateResult(snapshot(), false));

        mvc.perform(post("/api/management/tasks")
                        .header("Idempotency-Key", "alert-t039-create-001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "source": "alertmanager",
                                  "sourceRef": "alert-1",
                                  "caseId": "t039",
                                  "title": "checkout latency"
                                }
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.replayed").value(false))
                .andExpect(jsonPath("$.data.snapshot.task.taskId").value(
                        "TASK-00000000-0000-0000-0000-000000000001"
                ));
    }

    @Test
    void createReturns200ForIdempotentReplay() throws Exception {
        when(service.create(any())).thenReturn(new TaskCreateResult(snapshot(), true));

        mvc.perform(post("/api/management/tasks")
                        .header("Idempotency-Key", "alert-t039-create-001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "source": "alertmanager",
                                  "sourceRef": "alert-1",
                                  "caseId": "t039",
                                  "title": "checkout latency"
                                }
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.replayed").value(true));
    }

    @Test
    void executeReturns202() throws Exception {
        when(service.execute("TASK-00000000-0000-0000-0000-000000000001"))
                .thenReturn(snapshot());

        mvc.perform(post(
                        "/api/management/tasks/TASK-00000000-0000-0000-0000-000000000001/execute"
                ))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.data.task.status").value("PENDING"));
    }

    private TaskSnapshot snapshot() {
        var now = Instant.parse("2026-10-01T00:00:00Z");
        return new TaskSnapshot(
                new TaskView(
                        "TASK-00000000-0000-0000-0000-000000000001",
                        "alertmanager",
                        "alert-1",
                        "t039",
                        "checkout latency",
                        "PENDING",
                        null,
                        now,
                        now
                ),
                null
        );
    }
}
