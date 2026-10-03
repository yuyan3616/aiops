package com.piops.management.persistence.repository;

import com.piops.management.domain.enums.ExecutionStatus;
import com.piops.management.domain.model.ManagementExecution;
import com.piops.management.persistence.entity.ManagementExecutionEntity;
import com.piops.management.persistence.mapper.ManagementExecutionMapper;
import com.piops.management.repository.ExecutionRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public class MybatisExecutionRepository implements ExecutionRepository {

    private final ManagementExecutionMapper mapper;

    public MybatisExecutionRepository(ManagementExecutionMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public Optional<ManagementExecution> findById(String executionId) {
        return Optional.ofNullable(mapper.selectById(executionId)).map(this::toDomain);
    }

    @Override
    public Optional<ManagementExecution> findLatestByTaskId(String taskId) {
        return Optional.ofNullable(mapper.findLatestByTaskId(taskId)).map(this::toDomain);
    }

    @Override
    public ManagementExecution lockById(String executionId) {
        var entity = mapper.lockById(executionId);
        if (entity == null) {
            throw new IllegalArgumentException("Management execution not found: " + executionId);
        }
        return toDomain(entity);
    }

    @Override
    public int nextAttempt(String taskId) {
        return mapper.findMaxAttempt(taskId) + 1;
    }

    @Override
    public ManagementExecution insert(ManagementExecution execution) {
        var entity = toEntity(execution);
        mapper.insert(entity);
        return toDomain(entity);
    }

    @Override
    public ManagementExecution update(ManagementExecution execution) {
        var entity = toEntity(execution);
        if (mapper.updateById(entity) != 1) {
            throw new IllegalStateException(
                    "Management execution update lost optimistic-lock race: " + execution.executionId()
            );
        }
        return toDomain(entity);
    }

    private ManagementExecution toDomain(ManagementExecutionEntity entity) {
        return new ManagementExecution(
                entity.getId(),
                entity.getTaskId(),
                entity.getAttempt(),
                entity.getRuntimeRequestId(),
                entity.getInvestigationId(),
                ExecutionStatus.valueOf(entity.getStatus()),
                entity.getFailureCode(),
                entity.getFailureMessage(),
                entity.getStartedAt(),
                entity.getFinishedAt(),
                entity.getRowVersion(),
                entity.getCreatedAt(),
                entity.getUpdatedAt()
        );
    }

    private ManagementExecutionEntity toEntity(ManagementExecution execution) {
        var entity = new ManagementExecutionEntity();
        entity.setId(execution.executionId());
        entity.setTaskId(execution.taskId());
        entity.setAttempt(execution.attempt());
        entity.setRuntimeRequestId(execution.runtimeRequestId());
        entity.setInvestigationId(execution.investigationId());
        entity.setStatus(execution.status().name());
        entity.setFailureCode(execution.failureCode());
        entity.setFailureMessage(execution.failureMessage());
        entity.setStartedAt(execution.startedAt());
        entity.setFinishedAt(execution.finishedAt());
        entity.setRowVersion(execution.version());
        entity.setCreatedAt(execution.createdAt());
        entity.setUpdatedAt(execution.updatedAt());
        return entity;
    }
}
