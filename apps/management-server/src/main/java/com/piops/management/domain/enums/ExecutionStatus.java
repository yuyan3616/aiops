package com.piops.management.domain.enums;

/**
 * 一次 Task 执行尝试的状态。
 *
 * UNKNOWN 用来表达“请求结果不确定”，例如 Runtime 已接收写请求但 Spring 在收到响应前超时。
 * 这种状态不能直接按 FAILED 重试，否则可能产生重复执行。
 */
public enum ExecutionStatus {
    CREATED,
    DISPATCHING,
    RUNNING,
    SUCCEEDED,
    FAILED,
    CANCELLED,
    UNKNOWN
}
