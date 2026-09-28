# AGENTS.md

## 项目

这是一个面向 AIOps 场景的 RCA 智能调查系统。

核心链路：

```text
Conversation
→ Main Agent
→ Investigation
→ Hypothesis
→ Expert Agent
→ Tool / Evidence
→ RCA Report
```

产品定位是 **AIOps / RCA Investigation Workspace**，不是通用 AI Chat。

修改 RCA 相关代码时，根据当前任务阅读必要的实现，不需要为了小改动预先阅读整个仓库。

## 开发原则

- 优先定位并修复根因，不要用 timeout、retry、setTimeout、前端假状态或特殊 case 掩盖生命周期和并发问题。
- Server / 持久化数据是 Investigation 状态的事实来源，前端不得自行伪造最终状态。
- Main Agent 负责调查调度、Hypothesis 演化和最终收敛；Expert Agent 负责专项取证，不应越权决定整个 RCA 结论。
- Tool Result 必须能够真正返回给 Agent 使用，不能只用于 UI 展示。
- 调查相关修改需要注意异步任务、SSE、Pause、Resume、Cancel、页面刷新和服务重启后的状态一致性。
- 不要为了代码形式更漂亮而顺手重写稳定的 orchestrator、Agent runtime、event system 或 persistence。
- 修改现有协议、状态模型和持久化结构时，注意历史调查数据和现有前端兼容性。

## 特别约束

- `/api/rca` 是未来告警平台接入预留的独立 HTTP 接口，不要因为当前页面没有直接使用而删除。
- 不要默认将模型原始 Chain-of-Thought 直接展示给用户；UI 展示应以调查步骤、工具调用、关键观察和阶段性结论为主。
- 不要因为代码当前看起来没有调用就直接删除；先确认是否属于恢复逻辑、兼容逻辑、后台调用或预留能力。
- Railway 是当前 Production Runtime。修改启动命令、PORT、环境变量、持久化路径或部署配置时谨慎处理。
- GitHub Actions / Build 成功不代表 Railway Runtime 一定正常，需要区分构建问题与运行时崩溃。

## 修改与验证

根据修改范围执行必要的检查，例如：

```bash
typecheck
lint
test
build
```

只运行与当前修改相关且必要的验证，不需要机械地执行所有检查。

涉及 RCA 生命周期、异步任务或状态管理时，应额外检查受影响的异常路径。

完成任务前，确认：

- 修改解决的是实际问题而不是表面现象；
- 没有破坏无关行为；
- 没有遗留明显的临时代码或调试代码。

## Git

Git commit message 默认使用中文。

推荐格式：

```text
类型: 中文描述
```

例如：

```text
修复: 调查暂停后同步终止子 Agent
功能: 支持历史会话批量删除
优化: 调整调查列表时间展示
文档: 补充 Agent 开发规范
部署: 调整 Railway 启动配置
```

常用类型：

```text
功能 / 修复 / 优化 / 重构 / 文档 / 测试 / 部署 / 构建 / 清理
```

提交信息应清楚说明实际改动，避免使用 `update`、`修改代码`、`修复问题` 等模糊描述。

除非用户明确要求，否则不要使用英文 commit message。

## 边界

`AGENTS.md` 用于约束开发本项目的 Coding Agent。

RCA Main Agent、Expert Agent、Tool 策略、模型语言等运行时行为，应由对应的 Runtime Prompt / Agent Config 管理，不要把运行时 Prompt 堆进本文件。
