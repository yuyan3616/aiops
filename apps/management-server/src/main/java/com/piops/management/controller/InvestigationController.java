package com.piops.management.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.piops.management.client.AgentRuntimeClient.CancelInvestigationResult;
import com.piops.management.common.ApiResponse;
import com.piops.management.service.InvestigationService;
import jakarta.validation.constraints.Pattern;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/management/investigations")
public class InvestigationController {

    private final InvestigationService investigationService;

    public InvestigationController(InvestigationService investigationService) {
        this.investigationService = investigationService;
    }

    @GetMapping("/{investigationId}")
    public ApiResponse<JsonNode> get(
            @PathVariable
            @Pattern(regexp = "^INV-[A-Za-z0-9-]+$", message = "invalid investigation id")
            String investigationId
    ) {
        return ApiResponse.success(investigationService.get(investigationId));
    }

    @PostMapping("/{investigationId}/cancel")
    public ApiResponse<CancelInvestigationResult> cancel(
            @PathVariable
            @Pattern(regexp = "^INV-[A-Za-z0-9-]+$", message = "invalid investigation id")
            String investigationId
    ) {
        return ApiResponse.success(investigationService.cancel(investigationId));
    }
}
