package com.piops.management.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

class ManagementApiTokenFilterTest {

    private static final String TOKEN = "management-service-token-123";

    @Test
    void acceptsExactBearerTokenForTaskApi() throws Exception {
        var filter = new ManagementApiTokenFilter(
                new ManagementApiProperties(TOKEN),
                new ObjectMapper()
        );
        var request = new MockHttpServletRequest("GET", "/api/management/tasks/TASK-1");
        request.addHeader("Authorization", "Bearer " + TOKEN);
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) ->
                ((MockHttpServletResponse) res).setStatus(204)
        );

        assertThat(response.getStatus()).isEqualTo(204);
    }

    @Test
    void rejectsWrongToken() throws Exception {
        var filter = new ManagementApiTokenFilter(
                new ManagementApiProperties(TOKEN),
                new ObjectMapper()
        );
        var request = new MockHttpServletRequest("GET", "/api/management/tasks/TASK-1");
        request.addHeader("Authorization", "Bearer wrong-management-token");
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) -> {
            throw new AssertionError("filter chain must not run");
        });

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(response.getContentAsString()).contains("UNAUTHORIZED");
    }

    @Test
    void failsClosedWhenTokenIsNotConfigured() throws Exception {
        var filter = new ManagementApiTokenFilter(
                new ManagementApiProperties(""),
                new ObjectMapper()
        );
        var request = new MockHttpServletRequest("POST", "/api/management/tasks");
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) -> {
            throw new AssertionError("filter chain must not run");
        });

        assertThat(response.getStatus()).isEqualTo(503);
        assertThat(response.getContentAsString()).contains("MANAGEMENT_API_DISABLED");
    }
}
