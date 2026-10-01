package com.piops.management.controller;

import com.piops.management.common.ApiResponse;
import com.piops.management.service.TaskExecutionPersistenceService.CreateTaskCommand;
import com.piops.management.service.TaskManagementService;
import com.piops.management.service.TaskManagementService.TaskSnapshot;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/management/tasks")
public class TaskController {

    private static final String IDEMPOTENCY_HEADER = "Idempotency-Key";

    private final TaskManagementService taskManagementService;

    public TaskController(TaskManagementService taskManagementService) {
        this.taskManagementService = taskManagementService;
    }

    /**
     * 只创建平台 Task，不自动触发模型执行。
     * 这样告警接入、人工审核和真正执行可以拥有不同的权限/审计边界。
     */
    @PostMapping
    public ResponseEntity<ApiResponse<TaskSnapshot>> create(
            @RequestHeader(IDEMPOTENCY_HEADER)
            @Size(min = 8, max = 256)
            String idempotencyKey,
            @Valid @RequestBody CreateTaskRequest request
    ) {
        var snapshot = taskManagementService.create(new CreateTaskCommand(
                request.source(),
                request.sourceRef(),
                request.caseId(),
                request.title(),
                idempotencyKey
        ));
        return ResponseEntity
                .status(HttpStatus.CREATED)
                .body(ApiResponse.success(snapshot));
    }

    @GetMapping("/{taskId}")
    public ApiResponse<TaskSnapshot> get(
            @PathVariable
            @Pattern(regexp = "^TASK-[0-9a-fA-F-]{36}$", message = "invalid task id")
            String taskId
    ) {
        return ApiResponse.success(taskManagementService.get(taskId));
    }

    @PostMapping("/{taskId}/execute")
    public ResponseEntity<ApiResponse<TaskSnapshot>> execute(
            @PathVariable
            @Pattern(regexp = "^TASK-[0-9a-fA-F-]{36}$", message = "invalid task id")
            String taskId
    ) {
        return ResponseEntity
                .status(HttpStatus.ACCEPTED)
                .body(ApiResponse.success(taskManagementService.execute(taskId)));
    }

    @PostMapping("/{taskId}/sync")
    public ApiResponse<TaskSnapshot> sync(
            @PathVariable
            @Pattern(regexp = "^TASK-[0-9a-fA-F-]{36}$", message = "invalid task id")
            String taskId
    ) {
        return ApiResponse.success(taskManagementService.sync(taskId));
    }

    public record CreateTaskRequest(
            @NotBlank
            @Size(max = 64)
            @Pattern(regexp = "^[A-Za-z0-9._-]+$", message = "source contains unsupported characters")
            String source,

            @Size(max = 255)
            String sourceRef,

            @NotBlank
            @Pattern(regexp = "^[tT]\\d{1,6}$", message = "caseId must match t<number>")
            String caseId,

            @NotBlank
            @Size(max = 255)
            String title
    ) {
    }
}
