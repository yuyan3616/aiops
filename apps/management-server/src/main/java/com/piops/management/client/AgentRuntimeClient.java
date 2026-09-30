package com.piops.management.client;

import com.fasterxml.jackson.databind.JsonNode;

public interface AgentRuntimeClient {

    JsonNode getInvestigation(String investigationId);

    CancelInvestigationResult cancelInvestigation(String investigationId);

    record CancelInvestigationResult(boolean cancelled) {
    }
}
