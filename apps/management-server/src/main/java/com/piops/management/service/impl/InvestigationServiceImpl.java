package com.piops.management.service.impl;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.client.AgentRuntimeClient;
import com.piops.management.client.AgentRuntimeClient.CancelInvestigationResult;
import com.piops.management.service.InvestigationService;
import org.springframework.stereotype.Service;

@Service
public class InvestigationServiceImpl implements InvestigationService {

    private final AgentRuntimeClient agentRuntimeClient;

    public InvestigationServiceImpl(AgentRuntimeClient agentRuntimeClient) {
        this.agentRuntimeClient = agentRuntimeClient;
    }

    @Override
    public JsonNode get(String investigationId) {
        return agentRuntimeClient.getInvestigation(investigationId);
    }

    @Override
    public CancelInvestigationResult cancel(String investigationId) {
        return agentRuntimeClient.cancelInvestigation(investigationId);
    }
}
