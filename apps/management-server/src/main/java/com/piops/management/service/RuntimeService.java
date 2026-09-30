package com.piops.management.service;

import com.piops.management.client.AgentRuntimeClient.RuntimeHealth;

public interface RuntimeService {

    RuntimeHealth health();
}
