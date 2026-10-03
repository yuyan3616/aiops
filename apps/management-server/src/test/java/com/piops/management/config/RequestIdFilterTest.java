package com.piops.management.config;

import com.piops.management.common.RequestIdContext;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

class RequestIdFilterTest {

    private final RequestIdFilter filter = new RequestIdFilter();

    @Test
    void keepsValidUpstreamRequestIdAndClearsContextAfterRequest() throws Exception {
        var request = new MockHttpServletRequest();
        request.addHeader(RequestIdFilter.HEADER_NAME, "upstream-123");
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) ->
                assertThat(RequestIdContext.get()).isEqualTo("upstream-123")
        );

        assertThat(response.getHeader(RequestIdFilter.HEADER_NAME)).isEqualTo("upstream-123");
        assertThat(RequestIdContext.get()).isNull();
    }

    @Test
    void replacesUnsafeRequestId() throws Exception {
        var request = new MockHttpServletRequest();
        request.addHeader(RequestIdFilter.HEADER_NAME, "bad id with spaces");
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) ->
                assertThat(RequestIdContext.get()).isNotBlank()
        );

        assertThat(response.getHeader(RequestIdFilter.HEADER_NAME))
                .isNotEqualTo("bad id with spaces");
        assertThat(RequestIdContext.get()).isNull();
    }
}
