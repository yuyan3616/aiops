用于定位端到端延迟。保留 parent-child 时间戳，识别真正具有因果意义的最长路径，把重叠 children 视为并发；比较 total duration 与已观测 child interval，报告出现 unexplained duration 的最小区段。绝不能仅凭 timing gap 推断内部 mechanism。
