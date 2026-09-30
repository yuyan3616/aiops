package com.piops.management.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.piops.management.persistence.entity.ManagementExecutionEntity;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface ManagementExecutionMapper extends BaseMapper<ManagementExecutionEntity> {

    @Select("""
            SELECT *
            FROM management_execution
            WHERE task_id = #{taskId}
            ORDER BY attempt DESC
            LIMIT 1
            """)
    ManagementExecutionEntity findLatestByTaskId(@Param("taskId") String taskId);

    @Select("""
            SELECT *
            FROM management_execution
            WHERE id = #{executionId}
            FOR UPDATE
            """)
    ManagementExecutionEntity lockById(@Param("executionId") String executionId);

    @Select("""
            SELECT COALESCE(MAX(attempt), 0)
            FROM management_execution
            WHERE task_id = #{taskId}
            """)
    int findMaxAttempt(@Param("taskId") String taskId);
}
