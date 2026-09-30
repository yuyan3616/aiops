package com.piops.management.domain.mapper;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.piops.management.domain.enums.ExecutionStatus;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class InvestigationExecutionStatusMapperTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final InvestigationExecutionStatusMapper mapper =
            new InvestigationExecutionStatusMapper();

    @Test
    void mapsKnownRuntimeStatuses() throws Exception {
        assertThat(mapper.map(objectMapper.readTree("{\"status\":\"running\"}")))
                .isEqualTo(ExecutionStatus.RUNNING);
        assertThat(mapper.map(objectMapper.readTree("{\"status\":\"cancelled\"}")))
                .isEqualTo(ExecutionStatus.CANCELLED);
        assertThat(mapper.map(objectMapper.readTree("{\"status\":\"completed\"}")))
                .isEqualTo(ExecutionStatus.SUCCEEDED);
        assertThat(mapper.map(objectMapper.readTree("{\"status\":\"interrupted\"}")))
                .isEqualTo(ExecutionStatus.FAILED);
    }

    @Test
    void unknownRuntimeStatusDoesNotPretendToBeFailed() throws Exception {
        assertThat(mapper.map(objectMapper.readTree("{\"status\":\"something-new\"}")))
                .isEqualTo(ExecutionStatus.UNKNOWN);
    }
}
