package com.piops.management.controller;

import com.piops.management.client.AgentRuntimeClient.RuntimeHealth;
import com.piops.management.service.RuntimeService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class RuntimeControllerTest {

    private final RuntimeService service = mock(RuntimeService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new RuntimeController(service))
            .build();

    @Test
    void returnsRuntimeHealth() throws Exception {
        when(service.health()).thenReturn(new RuntimeHealth("ok"));

        mvc.perform(get("/api/management/runtime/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.status").value("ok"));
    }
}
