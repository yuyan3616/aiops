package com.piops.management.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.client.AgentRuntimeClient.CancelInvestigationResult;

public interface InvestigationService {

    JsonNode get(String investigationId);

    CancelInvestigationResult cancel(String investigationId);
}
