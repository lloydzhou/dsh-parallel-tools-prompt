# dsh-parallel-tools-prompt

独立 DeepSeek Harness host-only 插件：用稳定的依赖感知提示，引导模型把当前已就绪、互不依赖的必要工具调用放在同一响应里，减少不必要的模型—工具往返。

**不是 DAG 执行器，也不是费用优化保证。** 不新增模型请求、不增加工具、不更改宿主安全分类、权限或调度器。效果取决于模型遵循度、任务依赖与运行环境，尚未做付费前向 A/B。

## 行为

- 插件启用后，默认通过 `contextReminder` 向所有 Agent（包括子智能体）提供提醒，覆盖除 `contextExcludePresetIds`（默认 `[ptc]`）以外的所有 preset 以及没有 preset 的会话；`presetIds` 与根 Agent 筛选不限制此通道。PTC 只暴露 `run_code`，根级调用是独占的，合批应发生在单个程序内部，所以默认跳过；排除判断每一步都做，会话中途切换 preset 后会按新 preset 补发或跳过。插件重载前已存活的子智能体也会在下一步骤获得提醒。
- `systemPromptSection` 是默认关闭的可选通道；只有此通道按符合条件的根 Agent 与 `presetIds` 筛选，默认目标为 `standard` 根 Agent，跳过子智能体及不在列表中的 preset。
- 使用公开 Agent 生命周期、session projection 与 `systemPrompt.section()`，不替换 preset。系统提示词 section 固定名称 `parallel-tools:guidance`、order 3200（排在所有单工具 section 1000–3000 与 MCP_SERVERS 3100 之后，不拆散工具说明、不先于它引用的 jobs/subagent 说明；在 TOOLS_SDK 5000 与输出/人设 section 之前）、禁止插值；不注入时间戳、工具列表或每轮变化的数据。
- 同一 Agent 幂等注册；插件卸载与 Agent 释放都清理 section。插件重载时为仍存活的目标根 Agent 补挂已启用的 section，并覆盖仍存活 Agent 的提醒通道；源码更新建议重启宿主加载新模块。
- 两个独立开关选择注入通道（默认只走 CONTEXT 提醒）：`contextReminder`（默认 `true`）与 `systemPromptSection`（默认 `false`，设为 `true` 输出 `systemPrompt.section()` 的指引内容）。提醒通过 `agent/pre-step` 在下一步骤追加一条带独立 `source.kind: parallel-tools-scheduling` 的 CONTEXT 消息，写入会话历史并渲染为 CONTEXT 块，与宿主 `time-context` 同一机制；去重以模型当前可见的历史（session surface）为准，而不是全量事件日志：可见历史里已有（含继承来的）提醒就不再注入；上下文压缩或裁剪把提醒替换掉之后（surface `replaceGeneration` 变化），下一步骤补发一次，压缩保留了提醒则不补发。CONTEXT 文本带前缀 `Tool-call scheduling (applies to every remaining step of this session):`，说明它对整个会话持续有效。两者可同时开启；同时关闭则插件不注入任何内容。提醒进入历史，卸载不会删除。这不是每轮重复提醒，也不保证长期遵循。
- 插件详情页（Plugins → 本插件）在描述与组件列表之间提供这两个开关的设置表单，开关即时写入当前 profile 的 patch。两个字段声明为 `.volatile()`，修改不重启插件：`contextReminder` 在下一步骤生效；系统提示词开关对修改之后重新组装提示词的会话生效（已建立的会话沿用旧提示词）。浏览器端由 `src/client` 经 `scripts/build-client.mjs` 构建为 `lib/client.js`，按宿主客户端模块格式封装；表单要求 profile 里条目 id 为 `parallel-tools-prompt`。
- 两个注入通道共用同一条规则：每次带工具调用的响应前，在心里列出参数已知的调用，逐条问“尚未返回的结果会不会改变我是否调用它、或传什么参数”；不会就本轮一起发出。只有其他后续调用都依赖这一个结果时，单调用才正确。
- 同一响应里的调用可能并发、顺序不定，所以结果决定下一步、需要审批、或触及同一状态（先读后改、改后运行、同一文件两次编辑）时保持顺序。不凑批：不把无关命令串进一条 shell 调用、不为短调用开子智能体、不做投机调用；不打印计划或添加调度专用轮次，正常的计划、todo 和审批流程照常遵守。
- 同轮多个工具调用不代表真正同时执行；执行并发仍由DSH调度器决定。

## 提示词设计逻辑

### 当前规则：逐条就绪检验，单调用要有理由

两个注入通道共用 [prompt.ts](<src/prompt.ts>) 中的 `BATCH_RULE`（约 1000 字符），分发的 skill 描述与其完全一致。设计要点：

- **一个能逐条回答的判据**：对每个参数已知的调用问“尚未返回的结果会不会改变我是否调用它、或传什么参数”。比抽象的“依赖 DAG”更容易在每一步执行，也不要求输出任何图或计划。
- **单调用要有理由**：只有其他后续调用都依赖这一个结果时，单调用才正确。把默认从“能合批就合批”变成“不合批要说得出原因”，但 `test → read failure → fix → retest` 这样的真实依赖链仍然合法。
- **点名常被漏掉的合批**：任务开头的读取与搜索；一个结果同时指向的多个文件或符号（例如栈追踪里的每一帧）；内容已确定后对不同文件的编辑；typecheck、lint、test 等只读检查。
- **用执行语义解释等待**：“同一响应里的调用可能并发、顺序不定”，所以结果决定下一步、需要审批、或触及同一状态（先读后改、改后运行、同一文件两次编辑）时要分开。
- **防凑批只禁真正的作弊**：不把无关命令串进一条 shell 调用、不为短调用开子智能体、不做投机调用；`build && test` 这类本身有依赖的串联不受影响。
- **删掉不改变行为的免责说明**：并发与收益的边界写在本文档里，不占提示词篇幅。
- **合批与执行并发分开**：同一响应携带多个调用，目标是减少本可避免的模型往返；工具是否真正同时运行仍取决于 runtime/宿主调度、安全限制与资源情况。合批不保证延迟、tokens 或费用下降。
- **后台重叠与同轮合批也分开**：后台任务运行期间，不依赖其结果、不会干扰其共享状态的独立工作可以继续。即使前后每轮都只有一个工具调用，实际工作仍可能重叠；应遵守宿主的任务跟踪、结果收集与禁止重复执行规则，而不是重复启动正在运行的工作。

`source.kind: parallel-tools-scheduling` 只是 CONTEXT 消息的来源标识和去重依据，不是并发开关。**成功注入 ≠ 模型遵循 ≠ 实际收益**：看到这条消息只能验证接入路径，不能据此判断模型已合批、runtime 已并发，或任务更快更省。

### 排查时区分三类情况

1. **已就绪但未合批**：模型已知道多个有用且独立的调用，输入也已知，却分到后续响应执行；这是调度提示可以针对的遗漏机会。
2. **尚未发现其他工作**：当时还没有识别出其他有用动作，不能仅凭事后看到多个调用就断言违反合批规则；需要区分动作发现不足与已知动作的调度不足。
3. **存在真实依赖**：下一步的参数、是否执行、审批或共享状态顺序取决于前一步；等待是正确行为。不能把所有单调用响应都归为失败。

人工观察中，手动以 user 身份重复提醒后，局部调试阶段仍持续单调用。这只是个案：任务依赖、可用动作、模型与上下文都可能影响结果，不能据此证明提示整体无效，也不能断定每次单调用都有必要；应结合原始消息与当时的依赖关系检查，而不是仅凭截图外推收益。

### 本次改进（当前源码已启用，效果未证实）

当前源码（`0.2.4`，尚未发布）的改动，不表示已更新运行中的宿主或已证实有效：

- **规则重写**：用上文的逐条就绪检验替换原来的“先发现动作，再查依赖 DAG”措辞；两个通道和 skill 描述同步更新，skill 正文改为“合批 / 等待 / 不凑批 / 后台”四节，并给出正反例。
- **CONTEXT 前缀**：系统提示词通道仍用 `Tool-call scheduling:`；CONTEXT 通道改为 `Tool-call scheduling (applies to every remaining step of this session):`，因为它只交付一次，需要说明对后续所有步骤有效。
- **压缩后补发**：去重改看模型当前可见的 surface，而不是全量事件日志。原先压缩删掉提醒后不会补发，模型从此看不到规则；现在会在下一步骤补发一次。
- **默认跳过 PTC**：新增 `contextExcludePresetIds`（默认 `[ptc]`）。
- **section 排序**：order 从 1050 改为 3200，挪到全部工具说明之后。
- **未改动**：注入频率、默认开关、宿主调度行为。收益仍需受控对比验证，实际并发由 runtime 决定。

## 版本、依赖与发布

插件版本 `0.2.4` 独立编号，不等于宿主版本。最低宿主要求 `>=0.2.3-alpha.2`，Node.js `>=24.9.0`。插件测试运行在 `0.2.3-alpha.2` 宿主依赖上。

宿主库以 peerDependencies 声明，同时列入 devDependencies 供构建测试：Cordis `4.2.0-alpha.1`、Schemastery `3.20.0-alpha.1`、DSH agent/llm/agent-preset-registry/session-projection/system-prompt 均为 `0.2.3-alpha.2`。不将宿主服务打包为普通运行依赖，避免重复服务身份。peer 依赖是精确版本，宿主升级后需要同步调整。

建议使用 `npm ci` 配合 npm lock，避免交替更新两种锁文件。包发布白名单包含构建产物、bundle patch、README、许可证与分析脚本，不包含测试、原始会话或调试捕获。`prepack` 自动构建；预发布默认 `next` tag。确认版本未占用后由维护者执行 `npm publish`；已发布版本不能覆盖。

## 作为 skill 分发（其他 agent 工具）

[`skills/batch-tool-calls/SKILL.md`](skills/batch-tool-calls/SKILL.md) 把规则直接写进 `description`：skill 目录里只有这一行描述常驻上下文，因此核心规则无需模型主动加载 skill 就可见；正文是同一规则的展开。复制该目录到支持 skill 的 agent 的 skills 目录即可。

边界：描述在目录中可能被截断，规则放在最前面；是否遵循取决于模型与工具对 skill 目录的处理，尚未在 DSH 之外验证。不支持 skill 的工具，可把正文复制进 `AGENTS.md` / `CLAUDE.md` 等常驻指令文件。

## 开发与安装

已在本地 Web profile 链接安装并进行人工观察。一次探索任务出现连续多调用批次，但模型同时发生切换，不能据此归因于插件或宣称 token/费用节省。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

确认愿意启用后，手动安装本目录到目标 profile，例如 `dsh plugin --profile web add .`；Desktop 选择 `--profile desktop`。本插件提供客户端设置 UI，可在 Plugins → 本插件详情页调整两个注入通道。

直接调用插件默认 `enabled: false`；bundle显式配置 `enabled: true`，安装bundle即选择启用。配置：

```yaml
enabled: true
systemPromptSection: false  # 默认；设为 true 选择启用系统提示词通道
contextReminder: true       # 默认；所有 Agent（含子智能体），排除下一项列出的 preset
contextExcludePresetIds: [ptc]  # 默认；不接收 CONTEXT 提醒的精确 preset ID，最多 32 项
presetIds: [standard]       # 默认；只筛选系统提示词通道的目标根 Agent
```

**注意：profile 的 `cordis.patch.yml` 覆盖本插件时，`config` 是整体替换、不与 bundle 默认值深合并。** 覆盖项必须写全需要的字段，尤其是 `enabled: true`；否则 `enabled` 回落为默认 `false`，插件静默不注入。省略的通道字段使用上述 schema 默认值；自定义系统提示词目标时也要保留所需 `presetIds`。已有 profile 中显式设置的值不会自动迁移：例如原来的 `contextReminder: false` 或 `systemPromptSection: true` 仍保留，需通过设置 UI 或手动修改 profile 才会改变。验收方式：系统提示词通道看新会话 `system/message` 中是否出现 `Tool-call scheduling:`；CONTEXT 通道看会话里是否出现 `source.kind` 为 `parallel-tools-scheduling` 的消息。

`presetIds` 是精确 ID 列表，不是正则，且只控制选择启用后的系统提示词通道，不影响 CONTEXT 提醒。系统提示词的自定义目标仅适用于原生工具调用 preset；不要把 PTC 加入该列表，以免对专用执行模式施加额外系统指导。CONTEXT 提醒由 `contextExcludePresetIds` 单独控制：默认跳过 PTC，覆盖 minimal、creator 等其他 preset、无 preset 会话及子智能体；同样是精确 ID 列表，设为 `[]` 则 PTC 也会收到提醒。根会话 fork 可以保留历史 parentSession，不会仅因此被当作子智能体；若继承了已有提醒，则不会再注入。

卸载会释放注册；已有模型历史中的旧指令不会被改写或删除。若宿主需要重新投影系统提示，生效边界由宿主管理；稳妥方式是重启后继续原会话。首次安装可能改变system前缀并影响一次缓存复用；不能保证零缓存影响。

## 参考与验证边界

主要借鉴 [bash-agent #99](https://github.com/lloydzhou/bash-agent/issues/99) 的就绪批次思路及 [#100](https://github.com/lloydzhou/bash-agent/issues/100) 对实测/离线估算的讨论；同时参考 [Anthropic并行调用指南](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)、[LLMCompiler](https://github.com/SqueezeAILab/LLMCompiler) 和 [Superpowers并行委派skill](https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md)。本插件提示词为针对DSH自行编写的简短文本，不移植其执行器或照搬专用工具调用格式。

提示词取舍：参考 [bash-agent 的系统提示词基准](https://github.com/lloydzhou/bash-agent/blob/main/tests/fixtures/system_prompt_expected.txt) 中“围绕当前子目标前瞻、独立证据一起收集、是否/如何执行由前序结果决定时等待、不凑调用”；借鉴 [LLMCompiler planner](https://github.com/SqueezeAILab/LLMCompiler/blob/main/src/llm_compiler/planner.py) 的动作输入依赖模型，但不引入其计划 DSL、`$id` 或 `join` 工具；采用 Superpowers 的共享状态隔离边界，而不是要求为普通工具调用创建子代理。Anthropic 指南也明确同轮调用的实际并发与执行顺序由宿主决定。

LLMCompiler收益来自框架与调度；bash-agent历史DAG合并收益是离线估算；这些都不是本插件的实测收益。生命周期测试只证明接入/清理正确，不证明模型更快、更省。

## 临时 LLM 提示调试

默认 `debugEnabled: false`。调试模式在公开 `llm/stream` 边界记录归一化请求中的完整系统/开发者提示，不是最终HTTP报文；后续适配器仍可能变换它。仅指定会话命中，日志不收集用户/工具结果正文、认证头、工具参数schema或endpoint。系统提示本身也可能包含内部路径和秘密，请将日志视为敏感数据，不提交仓库或上传公开issue。

配置 `debugEnabled: true`、精确的 `debugSessionId`、绝对路径 `debugOutputDir` 和 `debugMaxCalls`（默认3，上限10）。输出目录须当前用户所有且权限0700；其中放一个私有普通文件 `enabled` 才会开始捕获。关闭配置或移走此标记后停止捕获，单进程达到次数上限也会停止；默认模式不写文件。新代码首次加载需重启宿主。调试结束须移走标记并关闭配置，避免重启重新开始捕获。

## 评估建议

评估不能只看多调用响应比例或工具调用总数。先按当时可见的信息审查**漏掉的已知、独立、有用且已就绪的机会**，区分尚未发现的动作与真实依赖，并记录是否重复执行已完成或运行中的工作；再比较任务质量/正确率、模型响应与尝试轮次、重试/失败、端到端延迟及输入/输出 tokens（区分已知与未知、缓存与非缓存用量）。后台任务与独立工作的重叠需单独观察，不能用同轮多调用比例替代。

固定任务、模型、reasoning、权限、工作目录与工具，做受控配对比较；报告分布、中位数、IQR，单独标记首次提示变化的缓存成本。必须在质量不退化、不增加无用或重复调用的前提下解释轮次与耗时变化；上述是评估方案，不是本版本已经取得收益的声明。

离线分析仅对显式指定的日志文件运行，不默认扫描个人会话目录，不输出内容或路径：

```sh
node scripts/analyze-session.mjs --help
node scripts/analyze-session.mjs /path/to/session.v4.jsonl.zstd
```

按assistant/message中的tool-call块计算批量率和calls/response均值、中位数；`assistant/attempt`与`tool/call`另计，不当作远端计费API调用。输出tokens同时报告已知总量与未知响应数量。日志中的继承/seed事件会计入，重复输入文件不去重；不能据此推断实际并发、LLM耗时或因果收益。zstd压缩及展开数据各限64MiB。更详细口径见脚本帮助和测试。
