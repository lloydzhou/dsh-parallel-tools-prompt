# dsh-parallel-tools-prompt

独立 DeepSeek Harness host-only 插件：用稳定的依赖感知提示，引导模型把当前已就绪、互不依赖的必要工具调用放在同一响应里，减少不必要的模型—工具往返。

**不是 DAG 执行器，也不是费用优化保证。** 不新增模型请求、不增加工具、不更改宿主安全分类、权限或调度器。效果取决于模型遵循度、任务依赖与运行环境，尚未做付费前向 A/B。

## 行为

- 默认只作用于创建/恢复时的 `standard` 根 Agent；跳过子智能体、PTC、minimal、creator 等非目标会话。
- 使用公开 `agent/created`、`agents.roots()`、session projection 与 `systemPrompt.section()`，不替换 preset。
- 固定 section 名称 `parallel-tools:guidance`、order 1050、禁止插值；不注入时间戳、工具列表或每轮变化的数据。
- 同一 Agent 幂等注册；插件卸载与 Agent 释放都清理 section。插件重载时为仍存活的目标根 Agent 补挂 section；源码更新建议重启宿主加载新模块。
- 两个独立开关选择注入通道（默认只走系统提示词）：`systemPromptSection`（默认 `true`，注册 `systemPrompt.section()`）与 `contextReminder`（默认 `false`）。后者通过 `agent/pre-step` 在下一步骤追加一条带独立 `source.kind: parallel-tools-scheduling` 的 CONTEXT 提醒，写入会话历史并渲染为 CONTEXT 块，与宿主 `time-context` 同一机制；已持久化的 source 用于避免重复注入，每个 Agent 只交付一次。两者可同时开启；同时关闭则插件不注入任何内容。提醒进入历史，卸载不会删除。这不是每轮重复提醒，也不保证长期遵循。
- 插件详情页（Plugins → 本插件）在描述与组件列表之间提供这两个开关的设置表单，开关即时写入当前 profile 的 patch。两个字段声明为 `.volatile()`，修改不重启插件：`contextReminder` 在下一步骤生效；系统提示词开关对修改之后重新组装提示词的会话生效（已建立的会话沿用旧提示词）。浏览器端由 `src/client` 经 `scripts/build-client.mjs` 构建为 `lib/client.js`，按宿主客户端模块格式封装；表单要求 profile 里条目 id 为 `parallel-tools-prompt`。
- 单次调用合理时仍单次；路径、ID等参数必须已知；读后写、共享文件冲突、权限审批保持依赖顺序。不发明batch工具或额外规划轮次。
- 同轮多个工具调用不代表真正同时执行；执行并发仍由DSH调度器决定。

## 版本、依赖与发布

插件版本 `0.2.1-rc.1` 跟随 DSH 的 `0.2.1` 版本线，RC 序号独立递增，不等于宿主 RC 序号。最低宿主要求 `>=0.2.1-rc.3`，Node.js `>=24.9.0`。开发锁文件以 RC.5 为基线；RC.3 的相关接口已做源码比对，完整插件测试本次运行在 RC.5 依赖上，不冒充两套运行验收。

宿主库以 peerDependencies 声明，同时列入 devDependencies 供构建测试：Cordis `4.0.5`、Schemastery `3.18.5`、DSH agent/llm/preset-registry/session-projection/system-prompt 使用 `^0.2.1-rc.3`。不将宿主服务打包为普通运行依赖，避免重复服务身份。semver caret 不跨 `0.3`，也不自动接纳不同版本号的预发布版本。

建议使用 `npm ci` 配合 npm lock，避免交替更新两种锁文件。包发布白名单包含构建产物、bundle patch、README、许可证与分析脚本，不包含测试、原始会话或调试捕获。`prepack` 自动构建；预发布默认 `next` tag。确认版本未占用后由维护者执行 `npm publish`；已发布版本不能覆盖。

## 作为 skill 分发（其他 agent 工具）

[`skills/batch-tool-calls/SKILL.md`](skills/batch-tool-calls/SKILL.md) 把规则直接写进 `description`：skill 目录里只有这一行描述常驻上下文，因此核心规则无需模型主动加载 skill 就可见；正文是同一规则的展开。复制该目录到支持 skill 的 agent 的 skills 目录即可。

边界：描述在目录中可能被截断，规则放在最前面；是否遵循取决于模型与工具对 skill 目录的处理，尚未在 DSH 之外验证。不支持 skill 的工具，可把正文复制进 `AGENTS.md` / `CLAUDE.md` 等常驻指令文件。

## 开发与安装

尚未发布 npm；已在本地 Web profile 链接安装并进行人工观察。一次探索任务出现连续多调用批次，但模型同时发生切换，不能据此归因于插件或宣称 token/费用节省。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

确认愿意启用后，手动安装本目录到目标 profile，例如 `dsh plugin --profile web add .`；Desktop 选择 `--profile desktop`。本插件没有客户端 UI，不需要 `dsh.client`。

直接调用插件默认 `enabled: false`；bundle显式配置 `enabled: true`，安装bundle即选择启用。配置：

```yaml
enabled: true
systemPromptSection: true   # 默认；系统提示词通道
contextReminder: false      # 默认；设为 true 启用 CONTEXT 提醒通道
presetIds: [standard]
```

**注意：profile 的 `cordis.patch.yml` 覆盖本插件时，`config` 是整体替换、不与 bundle 默认值深合并。** 覆盖项必须写全需要的字段（至少 `enabled: true`、`presetIds`），否则 `enabled` 回落为默认 `false`，插件静默不注入。验收方式：系统提示词通道看新会话 `system/message` 中是否出现 `Tool-call scheduling:`；CONTEXT 通道看会话里是否出现 `source.kind` 为 `parallel-tools-scheduling` 的消息。

`presetIds` 是精确ID列表，不是正则。自定义目标仅适用于原生工具调用preset；不要把PTC加入以免对专用执行模式施加不合适的指导。根会话fork可以保留历史parentSession，不会仅因此被当作子智能体。

卸载会释放注册；已有模型历史中的旧指令不会被改写或删除。若宿主需要重新投影系统提示，生效边界由宿主管理；稳妥方式是重启后继续原会话。首次安装可能改变system前缀并影响一次缓存复用；不能保证零缓存影响。

## 参考与验证边界

主要借鉴 [bash-agent #99](https://github.com/lloydzhou/bash-agent/issues/99) 的就绪批次思路及 [#100](https://github.com/lloydzhou/bash-agent/issues/100) 对实测/离线估算的讨论；同时参考 [Anthropic并行调用指南](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)、[LLMCompiler](https://github.com/SqueezeAILab/LLMCompiler) 和 [Superpowers并行委派skill](https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md)。本插件提示词为针对DSH自行编写的简短文本，不移植其执行器或照搬专用工具调用格式。

LLMCompiler收益来自框架与调度；bash-agent历史DAG合并收益是离线估算；这些都不是本插件的实测收益。生命周期测试只证明接入/清理正确，不证明模型更快、更省。

## 临时 LLM 提示调试

默认 `debugEnabled: false`。调试模式在公开 `llm/stream` 边界记录归一化请求中的完整系统/开发者提示，不是最终HTTP报文；后续适配器仍可能变换它。仅指定会话命中，日志不收集用户/工具结果正文、认证头、工具参数schema或endpoint。系统提示本身也可能包含内部路径和秘密，请将日志视为敏感数据，不提交仓库或上传公开issue。

配置 `debugEnabled: true`、精确的 `debugSessionId`、绝对路径 `debugOutputDir` 和 `debugMaxCalls`（默认3，上限10）。输出目录须当前用户所有且权限0700；其中放一个私有普通文件 `enabled` 才会开始捕获。关闭配置或移走此标记后停止捕获，单进程达到次数上限也会停止；默认模式不写文件。新代码首次加载需重启宿主。调试结束须移走标记并关闭配置，避免重启重新开始捕获。

## 评估建议

主指标是每完成任务的模型响应/尝试数量，而不是工具调用总数。固定任务、模型、reasoning、权限、工作目录与工具；对比输出tokens、正确率、重试/失败及wall time；报告配对分布、中位数、IQR，单独标记首次提示变化的缓存成本。

离线分析仅对显式指定的日志文件运行，不默认扫描个人会话目录，不输出内容或路径：

```sh
node scripts/analyze-session.mjs --help
node scripts/analyze-session.mjs /path/to/session.v4.jsonl.zstd
```

按assistant/message中的tool-call块计算批量率和calls/response均值、中位数；`assistant/attempt`与`tool/call`另计，不当作远端计费API调用。输出tokens同时报告已知总量与未知响应数量。日志中的继承/seed事件会计入，重复输入文件不去重；不能据此推断实际并发、LLM耗时或因果收益。zstd压缩及展开数据各限64MiB。更详细口径见脚本帮助和测试。
