package com.piops.management.persistence.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.Version;

import java.time.Instant;

@TableName("management_task")
public class ManagementTaskEntity {

    @TableId
    private String id;
    private String source;
    private String sourceRef;
    private String caseId;
    private String title;
    private String status;
    private String currentExecutionId;
    private String idempotencyKeyHash;
    @Version
    private Long rowVersion;
    private Instant createdAt;
    private Instant updatedAt;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getSourceRef() { return sourceRef; }
    public void setSourceRef(String sourceRef) { this.sourceRef = sourceRef; }
    public String getCaseId() { return caseId; }
    public void setCaseId(String caseId) { this.caseId = caseId; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getCurrentExecutionId() { return currentExecutionId; }
    public void setCurrentExecutionId(String currentExecutionId) { this.currentExecutionId = currentExecutionId; }
    public String getIdempotencyKeyHash() { return idempotencyKeyHash; }
    public void setIdempotencyKeyHash(String idempotencyKeyHash) { this.idempotencyKeyHash = idempotencyKeyHash; }
    public Long getRowVersion() { return rowVersion; }
    public void setRowVersion(Long rowVersion) { this.rowVersion = rowVersion; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
