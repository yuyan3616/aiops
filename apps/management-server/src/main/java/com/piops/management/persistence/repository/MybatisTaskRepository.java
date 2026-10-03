package com.piops.management.persistence.repository;

import com.piops.management.domain.enums.TaskStatus;
import com.piops.management.domain.model.ManagementTask;
import com.piops.management.persistence.entity.ManagementTaskEntity;
import com.piops.management.persistence.mapper.ManagementTaskMapper;
import com.piops.management.repository.TaskRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public class MybatisTaskRepository implements TaskRepository {

    private final ManagementTaskMapper mapper;

    public MybatisTaskRepository(ManagementTaskMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public Optional<ManagementTask> findById(String taskId) {
        return Optional.ofNullable(mapper.selectById(taskId)).map(this::toDomain);
    }

    @Override
    public Optional<ManagementTask> findByIdempotency(String source, String idempotencyKeyHash) {
        return Optional.ofNullable(mapper.findByIdempotency(source, idempotencyKeyHash))
                .map(this::toDomain);
    }

    @Override
    public ManagementTask insert(ManagementTask task) {
        var entity = toEntity(task);
        mapper.insert(entity);
        return toDomain(entity);
    }

    @Override
    public ManagementTask lockById(String taskId) {
        var entity = mapper.lockById(taskId);
        if (entity == null) {
            throw new IllegalArgumentException("Management task not found: " + taskId);
        }
        return toDomain(entity);
    }

    @Override
    public ManagementTask update(ManagementTask task) {
        var entity = toEntity(task);
        if (mapper.updateById(entity) != 1) {
            throw new IllegalStateException(
                    "Management task update lost optimistic-lock race: " + task.taskId()
            );
        }
        return toDomain(entity);
    }

    private ManagementTask toDomain(ManagementTaskEntity entity) {
        return new ManagementTask(
                entity.getId(),
                entity.getSource(),
                entity.getSourceRef(),
                entity.getCaseId(),
                entity.getTitle(),
                TaskStatus.valueOf(entity.getStatus()),
                entity.getCurrentExecutionId(),
                entity.getIdempotencyKeyHash(),
                entity.getRowVersion(),
                entity.getCreatedAt(),
                entity.getUpdatedAt()
        );
    }

    private ManagementTaskEntity toEntity(ManagementTask task) {
        var entity = new ManagementTaskEntity();
        entity.setId(task.taskId());
        entity.setSource(task.source());
        entity.setSourceRef(task.sourceRef());
        entity.setCaseId(task.caseId());
        entity.setTitle(task.title());
        entity.setStatus(task.status().name());
        entity.setCurrentExecutionId(task.currentExecutionId());
        entity.setIdempotencyKeyHash(task.idempotencyKeyHash());
        entity.setRowVersion(task.version());
        entity.setCreatedAt(task.createdAt());
        entity.setUpdatedAt(task.updatedAt());
        return entity;
    }
}
