package com.piops.management.controller;

import com.piops.management.client.AgentRuntimeClient.RuntimeHealth;
import com.piops.management.common.ApiResponse;
import com.piops.management.service.RuntimeService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 管理面观察 Agent Runtime 的入口。
 *
 * 这里返回的是“管理面能否访问 Runtime”，不是业务 Investigation 的最终状态。
 */
@RestController
@RequestMapping("/api/management/runtime")
public class RuntimeController {

    private final RuntimeService runtimeService;

    public RuntimeController(RuntimeService runtimeService) {
        this.runtimeService = runtimeService;
    }

    @GetMapping("/health")
    public ApiResponse<RuntimeHealth> health() {
        return ApiResponse.success(runtimeService.health());
    }
}
