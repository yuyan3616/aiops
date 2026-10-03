CREATE TABLE management_task (
    id VARCHAR(64) NOT NULL,
    source VARCHAR(64) NOT NULL,
    source_ref VARCHAR(255) NULL,
    case_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL,
    current_execution_id VARCHAR(64) NULL,
    idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uk_management_task_source_idempotency
        UNIQUE (source, idempotency_key_hash),
    INDEX idx_management_task_status_updated (status, updated_at),
    INDEX idx_management_task_case_created (case_id, created_at),
    CONSTRAINT chk_management_task_status
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE management_execution (
    id VARCHAR(64) NOT NULL,
    task_id VARCHAR(64) NOT NULL,
    attempt INT UNSIGNED NOT NULL,
    runtime_request_id VARCHAR(64) NULL,
    investigation_id VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    failure_code VARCHAR(64) NULL,
    failure_message VARCHAR(1024) NULL,
    started_at TIMESTAMP(6) NULL,
    finished_at TIMESTAMP(6) NULL,
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uk_management_execution_task_attempt
        UNIQUE (task_id, attempt),
    CONSTRAINT uk_management_execution_runtime_request
        UNIQUE (runtime_request_id),
    CONSTRAINT uk_management_execution_investigation
        UNIQUE (investigation_id),
    INDEX idx_management_execution_task_status (task_id, status),
    INDEX idx_management_execution_status_updated (status, updated_at),
    CONSTRAINT fk_management_execution_task
        FOREIGN KEY (task_id) REFERENCES management_task(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_management_execution_status
        CHECK (status IN (
            'CREATED', 'DISPATCHING', 'RUNNING',
            'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'
        ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE management_task
    ADD CONSTRAINT fk_management_task_current_execution
        FOREIGN KEY (current_execution_id) REFERENCES management_execution(id)
        ON DELETE SET NULL ON UPDATE RESTRICT;
