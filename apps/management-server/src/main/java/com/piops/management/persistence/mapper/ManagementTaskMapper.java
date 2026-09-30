package com.piops.management.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.piops.management.persistence.entity.ManagementTaskEntity;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface ManagementTaskMapper extends BaseMapper<ManagementTaskEntity> {

    @Select("""
            SELECT *
            FROM management_task
            WHERE source = #{source}
              AND idempotency_key_hash = #{idempotencyKeyHash}
            LIMIT 1
            """)
    ManagementTaskEntity findByIdempotency(
            @Param("source") String source,
            @Param("idempotencyKeyHash") String idempotencyKeyHash
    );

    /**
     * reserve Execution 时锁住 Task 行。
     * 远程 Runtime 调用必须在这个数据库事务提交以后执行。
     */
    @Select("""
            SELECT *
            FROM management_task
            WHERE id = #{taskId}
            FOR UPDATE
            """)
    ManagementTaskEntity lockById(@Param("taskId") String taskId);
}
