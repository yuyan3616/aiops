package com.piops.management.controller;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import static org.hamcrest.Matchers.not;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 用真实 Spring Boot Filter/MVC/MySQL 链路验证 Task API。
 */
@SpringBootTest(properties = "management-api.token=integration-management-token-123")
@AutoConfigureMockMvc
@Transactional
class TaskApiIntegrationTest {

    private static final String TOKEN = "integration-management-token-123";

    @Autowired
    private MockMvc mvc;

    @Test
    void unauthorizedRequestStillCarriesRequestId() throws Exception {
        mvc.perform(get("/api/management/tasks/TASK-00000000-0000-0000-0000-000000000001")
                        .header("X-Request-ID", "task-api-auth-test"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("X-Request-ID", "task-api-auth-test"))
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
    }

    @Test
    void invalidTaskIdIsRejectedByRealMethodValidation() throws Exception {
        mvc.perform(get("/api/management/tasks/not-a-task")
                        .header("Authorization", "Bearer " + TOKEN))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("INVALID_REQUEST"));
    }

    @Test
    void createIsIdempotentAndDoesNotExposePersistenceInternals() throws Exception {
        String body = """
                {
                  "source": "alertmanager",
                  "sourceRef": "integration-alert-1",
                  "caseId": "t039",
                  "title": "checkout latency"
                }
                """;

        mvc.perform(post("/api/management/tasks")
                        .header("Authorization", "Bearer " + TOKEN)
                        .header("Idempotency-Key", "integration-task-api-001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.replayed").value(false))
                .andExpect(jsonPath("$.data.snapshot.task.caseId").value("t039"))
                .andExpect(content().string(not(containsString("idempotencyKeyHash"))))
                .andExpect(content().string(not(containsString("rowVersion"))))
                .andExpect(content().string(not(containsString("\"version\""))));

        mvc.perform(post("/api/management/tasks")
                        .header("Authorization", "Bearer " + TOKEN)
                        .header("Idempotency-Key", "integration-task-api-001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.replayed").value(true));
    }
}
