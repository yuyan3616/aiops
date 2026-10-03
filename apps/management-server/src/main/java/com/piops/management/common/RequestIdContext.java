package com.piops.management.common;

/**
 * 保存当前同步请求的 Request ID。
 *
 * Spring MVC 当前采用一请求一线程的同步模型，因此这里使用 ThreadLocal
 * 只负责在 Controller -> Service -> RuntimeClient 之间传递链路标识。
 * 若后续切换到异步执行或 WebFlux，需要重新评估上下文传播方式。
 */
public final class RequestIdContext {

    private static final ThreadLocal<String> REQUEST_ID = new ThreadLocal<>();

    private RequestIdContext() {
    }

    public static void set(String requestId) {
        REQUEST_ID.set(requestId);
    }

    public static String get() {
        return REQUEST_ID.get();
    }

    public static void clear() {
        REQUEST_ID.remove();
    }
}
