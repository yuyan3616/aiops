package com.piops.management.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.piops.management.client.AgentRuntimeClient.CancelInvestigationResult;
import com.piops.management.exception.GlobalExceptionHandler;
import com.piops.management.service.InvestigationService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class InvestigationControllerTest {

    private final InvestigationService service = mock(InvestigationService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new InvestigationController(service))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void getsInvestigationThroughService() throws Exception {
        var investigation = objectMapper.readTree("""
                {"id":"INV-test-1","status":"running"}
                """);
        when(service.get("INV-test-1")).thenReturn(investigation);

        mvc.perform(get("/api/management/investigations/INV-test-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.id").value("INV-test-1"))
                .andExpect(jsonPath("$.data.status").value("running"));

        verify(service).get("INV-test-1");
    }

    @Test
    void cancelsInvestigationThroughService() throws Exception {
        when(service.cancel("INV-test-1")).thenReturn(new CancelInvestigationResult(true));

        mvc.perform(post("/api/management/investigations/INV-test-1/cancel"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.cancelled").value(true));

        verify(service).cancel("INV-test-1");
    }
}
