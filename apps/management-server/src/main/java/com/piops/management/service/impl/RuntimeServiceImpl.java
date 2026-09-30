package com.piops.management.service.impl;

import com.piops.management.client.AgentRuntimeClient;
import com.piops.management.client.AgentRuntimeClient.RuntimeHealth;
import com.piops.management.service.RuntimeService;
import org.springframework.stereotype.Service;

@Service
public class RuntimeServiceImpl implements RuntimeService {

    private final AgentRuntimeClient agentRuntimeClient;

    public RuntimeServiceImpl(AgentRuntimeClient agentRuntimeClient) {
        this.agentRuntimeClient = agentRuntimeClient;
    }

    @Override
    public RuntimeHealth health() {
        return agentRuntimeClient.health();
    }
}
