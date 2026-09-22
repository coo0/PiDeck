# omp 第三 Agent 后端接入对照计划

> 目标：评估并规划把 **omp**（`@oh-my-pi/pi-coding-agent`）作为 PiDeck 的**第三个 agent 后端**接入，与现有 `pi` / `dsh` 并列，同一项目下三种 agent 会话可自由创建与浏览。
> 非目标：不做「同一会话中途换引擎」（pi / DSH / omp 会话文件格式互不相同，迁移=重放）；不把 omp 的 TUI 搬进 PiDeck；不为 omp 复刻 pi 专属能力（edit/delete 历史、rewind）。

**状态：** 调研完成，**未立项**（2026-09-21）。本文档是决策依据，不是已批准的执行计划。
**范围：** 桌面端；pi / dsh 现有链路零改动。
**原则：** omp 的事由 omp 做，PiDeck 只做进程、映射与 UI；沿用 `SessionAgentGateway` 契约与能力集机制。

---

## 1. 为什么考虑接入 omp

| 现状 | 诉求 |
|------|------|
| PiDeck 已支持 `pi`（stdio JSON-RPC）与 `dsh`（utilityProcess + ApiProxy）两种后端 | 用户希望把 omp 也纳入同一桌面工作台 |
| omp 是独立 CLI（`omp`），有自己的 TUI、配置目录与插件体系 | 不希望它只能作为「外部终端」游离在会话链路之外 |
| omp 迭代极快（18.x，634 个已发布版本） | 需要先判断协议稳定性，再决定投入深度 |

**与 DSH 的关键差异：** DSH 是「框架 + 可程序化引导」（`boot()` 返回 Cordis Context），omp 是「自带 CLI 的完整应用」，暴露的是 **`--mode rpc` 子进程协议**。因此 omp 更接近 `pi` 的接入形态（子进程 + JSONL），而不是 DSH 的内嵌形态。

---

## 2. 调研结论（omp 18.2.7，基于 npm 包源码核查）

> 证据路径：`@oh-my-pi/pi-coding-agent@18.2.7` tarball（`https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-18.2.7.tgz`）。完整文件索引见 §11。

### 2.1 包身份与形态

| 项 | 值 |
|---|---|
| 包名 | `@oh-my-pi/pi-coding-agent` |
| 命令 | `omp`（`bin.omp → dist/cli.js`） |
| 版本 | `18.2.7`（`dist-tags.latest`） |
| 描述 | Coding agent CLI with read, bash, edit, write tools and session management |
| 仓库 | `github.com/can1357/oh-my-pi`（monorepo，`packages/coding-agent`） |
| 作者 | Stencil Labs, Inc.（contributors 含 Mario Zechner） |
| License | MIT |
| 体积 | unpacked ≈ 49 MB / 2700 文件 |
| 官网 | `https://omp.sh`（SPA，无静态文档可抓） |

**它不是 pi 的分支**，是独立代码库；RPC 协议「看着像同源」但为各自实现。

### 2.2 运行时硬依赖 Bun（最关键约束）

```jsonc
// package.json
"engines": { "bun": ">=1.3.14" },
"scripts": { "build": "bun scripts/build-binary.ts" }
```

源码直接使用 Bun 专有 API：

```ts
// src/modes/rpc/rpc-input.ts
export function claimRpcInput(): ReadableStream<Uint8Array> {
	const reader = Bun.stdin.stream().getReader();
	...
}
```

其他 Bun 绑定：`bun:sqlite`（`legacy-pi-compat.ts`）、`Bun.file()`、`Bun.resolveSync`。

**结论：** 不能像 DSH 那样复用 PiDeck 现有的 Node runner（`scripts/pack-dsh-runner-node.mjs`）。要跑 omp 必须引入 **Bun 二进制**。

### 2.3 RPC 模式（嵌入用途，官方明示）

```ts
// src/modes/rpc/rpc-mode.ts 头注释
/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 */
```

CLI 模式枚举（`src/cli/args.ts`）：

```ts
export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";
```

即 `omp --mode rpc` 是官方支持的嵌入入口，另有 `acp`（Agent Client Protocol）可选。

### 2.4 分帧协议：与 pi 不兼容（第二个硬约束）

omp 的 RPC 不是纯 JSONL，有**协议版本协商 + 分片重组 + 超帧自动裁剪**：

```ts
// src/modes/rpc/rpc-frame.ts
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;              // 单帧 1 MB
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;   // 重组上限 64 MB
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;                  // 分片载荷 256 KB
```

握手与协商（`src/modes/rpc/rpc-types.ts`）：

```ts
// 服务端启动后先发 ready
{ type: "ready"; protocolVersion: 1; supportedProtocolVersions: [1, 2];
  maxFrameBytes: number; maxReassembledFrameBytes: number }

// 客户端随后协商
{ id?: string; type: "negotiate_protocol"; protocolVersion: number }
→ { command: "negotiate_protocol"; success: true; data: { protocolVersion: 2 } }
```

超帧处理用**七档渐进裁剪**（`SHRINK_PASSES`），把过大字段截断并标注 `…[N chars elided for RPC frame]`，而不是直接失败。

**对比 pi：** `src/main/pi/PiRpcClient.ts` 是**纯 JSONL 行缓冲**实现，只有 `MAX_RPC_LINE_BYTES` 溢出保护，无协商、无分片。

**结论：** `PiRpcClient` **不能复用**，需要写 omp 专用 client（见 §6.3）。

### 2.5 pi 扩展兼容层（改变工作量的关键发现）

omp 内置 `legacy-pi-compat`，用 Babel 解析并改写 pi 扩展的 import：

```ts
// src/extensibility/plugins/legacy-pi-compat.ts
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent",
                          "pi-natives", "pi-tui", "pi-utils"] as const;

const LEGACY_PI_SPECIFIER_FILTER =
	new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
```

配套 shim 文件：`legacy-pi-ai-shim.ts` / `legacy-pi-coding-agent-shim.ts` / `legacy-pi-tui-shim.ts`。

**PiDeck 侧现状（实测 13 个内置扩展的 import 分布）：**

```text
9  @earendil-works/pi-coding-agent
6  @earendil-works/pi-ai
3  @earendil-works/pi-agent-core
1  @earendil-works/pi-ai/compat
2  typebox        1  undici        (其余为 node: 内置模块)
```

`@earendil-works` 正在 omp 的 `PI_SCOPE_ALIASES` 白名单内。

**结论（推翻早期判断）：** PiDeck 的 `pi-deck-*.ts` **理论上可被 omp 直接加载**，不必全部重写。这是本方案最大的成本削减项，但**必须实测验证**——兼容层覆盖的是 API 表面，语义（如 `pi.on("message_end")` 的时序、`ctx.ui.*` 行为）仍需逐项确认。

### 2.6 配置与会话目录

```ts
// @oh-my-pi/pi-utils/src/dirs.ts
export const CONFIG_DIR_NAME: string = ".omp";
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;
// 可用 PI_CONFIG_DIR 覆盖，PI_CODING_AGENT_DIR 覆盖 agent 目录
// profile: OMP_PROFILE / PI_PROFILE → ~/.omp/profiles/<name>/agent
```

| 项 | omp | pi（对比） |
|---|---|---|
| 配置根 | `~/.omp/`（`PI_CONFIG_DIR` 可覆盖） | `~/.pi/agent/` |
| 主配置 | `config.yml` / `config.yaml` | `settings.json` |
| 模型配置 | `models-config`（独立 schema） | `models.json` |
| agent 目录 | `~/.omp/agent/` | `~/.pi/agent/` |
| 会话 | `~/.omp/agent/sessions/` | `~/.pi/agent/sessions/` |

另有 `session-migrations.ts`、`foreign-session-import.ts`、`claude-paths.ts` —— 具备会话/配置迁移能力，但**不代表可直接读 pi 的 models.json**。

### 2.7 RPC 命令全集（实测枚举）

```text
# 提示与回合
prompt  prompt_result  steer  follow_up  abort  abort_and_prompt  handoff

# 状态与消息
get_state  get_messages  get_messages_page  get_last_assistant_text
get_session_stats  get_branch_messages  branch  new_session  switch_session

# 模型与思考
get_available_models  set_model  cycle_model
set_thinking_level  cycle_thinking_level  set_fast_mode

# 压缩与重试
compact  set_auto_compaction  set_auto_retry  abort_retry

# 命令与技能
get_available_commands  available_commands_update  set_todos  set_session_name

# 工具与 UI
bash  abort_bash  set_host_tools  host_tool_call  host_tool_cancel
host_tool_result  host_tool_update  set_host_uri_schemes  host_uri_request
host_uri_result  host_uri_cancel  extension_ui_request  extension_ui_response

# 子 agent
get_subagents  get_subagent_messages  set_subagent_subscription
subagent_event  subagent_lifecycle  subagent_progress

# 其它
export_html  login  get_login_providers  set_steering_mode  set_follow_up_mode
set_interrupt_mode  negotiate_protocol  ready  response  rpc_chunk
```

对照 pi 的 RPC 命令集（`src/main/pi/AgentManager.ts` + `PiProcess.ts` 实测）：

```text
abort  abort_bash  bash  clone  cycle_model  cycle_thinking_level  end
export_html  extension_ui_response  fork  get_available_models
get_available_thinking_levels  get_commands  get_entries  get_fork_messages
get_messages  get_session_stats  get_state  prompt  reload_config  set_model
set_session_name  set_thinking_level  start  switch_session
```

**omp 缺失的 pi 命令：** `fork`、`get_fork_messages`、`get_entries`、`reload_config`、`get_available_thinking_levels`（后者可用 `get_state` 推断）。
**omp 多出的能力：** 子 agent 三件套、host tools / host URI 桥、`get_messages_page` 游标分页、`set_auto_retry`、`handoff`。

### 2.8 Bun 二进制分发可行性

npm `bun` 包（latest `1.4.2`）提供 12 个平台 optionalDependencies：

```text
@oven/bun-darwin-x64      @oven/bun-darwin-aarch64
@oven/bun-linux-x64       @oven/bun-linux-aarch64
@oven/bun-linux-x64-musl  @oven/bun-linux-aarch64-musl
@oven/bun-windows-x64     @oven/bun-windows-aarch64
@oven/bun-freebsd-x64     @oven/bun-freebsd-aarch64
@oven/bun-linux-x64-android  @oven/bun-linux-aarch64-android
```

可复用 PiDeck 现有 runtime 分发模式（`scripts/pack-dsh-runtime.mjs` + `dist-runtime/` + `extraResources` + 按需下载），无需自建分发基建。

---

## 3. 方案决策

### 3.1 三种接入档位

| 档 | 内容 | 成本估算 | 建议 |
|---|---|---|---|
| **A. 外部终端** | PiDeck 终端里手动跑 `omp`，不进会话链路 | 1–2 天 | ✅ **建议先做**，用于验证 |
| **B. 最小后端** | 作为第三后端：新建会话 + 收发消息 + 中止 + 模型切换；无历史扫描/用量/Plan | 3–5 周 | ⚠️ 视 A 的验证结果 |
| **C. 完整对齐** | 对齐 DSH 全部能力（会话恢复、用量、扩展注入、安全门） | 2–3 月 | ❌ 暂不建议 |

**推荐路径：A → 评估 → 再决定 B/C。** 理由：omp 迭代极快（18.x、634 版本），协议与兼容层都可能变动；先用最低成本验证「Bun 能起、RPC 能通、扩展能加载」这三件事，再投入。

### 3.2 若做后端：传输形态选型

| 形态 | 说明 | 评估 |
|---|---|---|
| **子进程 + stdio RPC**（选） | `spawn(bun, [omp, "--mode", "rpc"])`，与 pi 同构 | ✅ 官方嵌入形态；隔离性好；崩溃不拖主进程 |
| 主进程内嵌 | 直接 import omp 源码 | ❌ Bun 专有 API 在 Electron 主进程不可用 |
| ACP 模式 | `--mode acp`（Agent Client Protocol） | ⚠️ 备选；ACP 是通用协议，但需评估与 PiDeck 模型的映射成本 |

**决策：子进程 + stdio RPC。** 与 `PiProcess` 同构，PiDeck 侧进程管理/退出清理经验可直接复用。

### 3.3 配置隔离策略

参照 `pideckDshHome.ts` 的做法，通过环境变量把 omp 的配置根指向 PiDeck 管理的目录：

```text
PI_CONFIG_DIR=<userData>/omp-home     # 覆盖默认 ~/.omp
```

好处：不污染用户真实 `~/.omp`；可与 PiDeck 的项目/会话生命周期绑定；卸载时可整体清理。
代价：用户已有的 omp 配置需要迁移或重新配置（可提供导入入口）。

---

## 4. 硬契约（合并门禁）

> 本节规则沿用 `docs/dsh-agent-backend-plan.md` §4 的既有约定，针对 omp 做增补。

1. **pi / dsh 零回归**：`AgentManager` / `PiProcess` / `PiRpcClient` / `DshAgentManager` 行为不变；现有测试全绿。
2. **类型向后兼容**：`AgentBackend` 由 `"pi" | "dsh" | "imagegen"` 扩展为含 `"omp"`；`SessionRecord.backend` **缺省仍为 `"pi"`**，旧 catalog 无需迁移。
3. **网关能力集化**：`SessionAgentGateway.capabilities` 显式声明 omp 缺失的能力（editMessage / deleteMessage / rewind / reload_config）；Coordinator 与渲染层按能力禁用 UI，**禁止硬造等价物**。
4. **单向依赖**：新增 `src/main/omp/` 只依赖 `shared/` 契约；渲染层只经 preload/IPC；禁止 renderer 直接 import Node/Electron 或 omp 包。
5. **IPC 注册式**：新通道一律进 `shared/ipc.ts` + `main/ipc/*Ipc.ts` + preload 三处同步；优先复用现有 `sessions:runtime-*` 后端无关通道。
6. **事件按 session 隔离**：runtime 事件必须带 `sessionId + agentId + runtimeGeneration`；沿用 Coordinator 机制，拒绝旧 runtime 迟到结果。
7. **生命周期配对**：omp 子进程（及 Bun）必须登记进退出清理清单；`stopAll` 路径覆盖。
8. **协议健壮性**：分帧解析必须处理分片、超大帧裁剪、协商失败降级；stdout 被非 JSON 污染时报协议错误而非崩溃。
9. **安全边界**：omp 的审批/提问必须经用户确认（复用 `agents:ui-request` 链路）；自动放行默认关闭。
10. **测试门禁**：`npm run typecheck` + 针对性单测全绿；分帧/协议解析等纯函数必须有单测；探针脚本不入产品构建。
11. **Bun 分发契约**：Bun 二进制版本锁定；下载走既有 runtime 分发模式（sha256 校验 + 按需下载 + 失败可诊断）；不得把 Bun 打进 asar。

---

## 5. 明确不做

| 项 | 理由 |
|---|---|
| 同会话中途切换引擎（pi ↔ dsh ↔ omp） | 三方会话文件格式互不相同，迁移=重放，语义与成本都不可接受 |
| 导入 omp 历史会话作为只读浏览源 | 一期不做 scanner；若做需先确认 `session-migrations` 的可读性 |
| 把 omp TUI 搬进 PiDeck | 违反「omp 的事由 omp 做」；PiDeck 只做渲染层自有视图 |
| 复刻 pi 专属能力给 omp | edit/delete 历史、rewind checkpoint 等 omp 无对应 RPC；能力集声明缺失即可 |
| 复用 `PiRpcClient` | 分帧协议不兼容，强行复用会引入隐蔽 bug |
| 复用 DSH 的 runner-node | omp 需要 Bun，不是 Node |
| 把 Bun 打进 asar | 原生可执行文件不能进 asar；且体积与签名都不可接受 |
| 为 omp 改 `pi-deck-*.ts` 的 import | 应由 omp 的兼容层处理；若实测不通过再评估，不预先改源码 |

---

## 6. PiDeck 侧架构设计

### 6.1 类型层（`src/shared/`）

```ts
// src/shared/types/agent.ts
export type AgentBackend = "pi" | "dsh" | "omp" | "imagegen";
```

新增类型（建议放 `src/shared/types/omp.ts`）：

```ts
export type OmpRpcProtocolVersion = 1 | 2;

export type OmpRuntimeInfo = {
	/** Bun 可执行文件路径（随包或按需下载） */
	bunPath: string;
	/** omp CLI 入口（node_modules 内的 dist/cli.js） */
	ompEntry: string;
	version: string;
};
```

### 6.2 网关层：能力集 + 按 backend 路由

现有机制（`src/main/sessions/SessionRuntimeCoordinator.ts`）：

```ts
export interface SessionAgentGateway {
	readonly backend: AgentBackend;
	readonly capabilities: ReadonlySet<AgentGatewayCapability>;
	list(): AgentTab[];
	sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
	create(input: CreateAgentInput): Promise<AgentTab>;
	abort(agentId: string): Promise<void>;
	// …（约 40 个方法，含大量可选能力）
}
```

`AgentGatewayCapability`（`src/shared/types/agent.ts`）：

```ts
export type AgentGatewayCapability =
	| "compact" | "fork" | "getForkMessages" | "editMessage"
	| "deleteMessage" | "getCommands" | "exportHtml" | "rewind";
```

**omp 网关声明（建议）：**

```ts
const OMP_CAPABILITIES: ReadonlySet<AgentGatewayCapability> =
	new Set(["compact", "exportHtml", "getCommands"]);
// 缺失：fork / getForkMessages / editMessage / deleteMessage / rewind
```

路由由 `CompositeAgentGateway` 按 `backend` 分发，无需改动调用方。

### 6.3 新模块 `src/main/omp/`（对标 `src/main/pi/`）

```text
src/main/omp/
├── OmpAgentManager.ts      # 对标 AgentManager：会话生命周期、事件投影、状态机
├── OmpProcess.ts           # 对标 PiProcess：spawn bun + omp --mode rpc、环境清洗、退出处理
├── OmpRpcClient.ts         # ★ 对标 PiRpcClient：分帧协议（不可复用 pi 实现）
├── ompFrame.ts             # 分片重组 / 超帧裁剪（纯函数，可单测）
├── ompEventProjector.ts    # omp 事件 → PiDeck ChatMessage/AgentRuntimeState
├── ompSessionPath.ts       # ~/.omp/agent/sessions/ 路径解析
├── ompModels.ts            # get_available_models → AvailableModel 映射
├── ompRuntimeManager.ts    # Bun 二进制解析（随包 / 按需下载）
└── ompRuntimeInstall.ts    # Bun 下载与校验
```

**`OmpRpcClient` 与 `PiRpcClient` 的差异（核心实现点）：**

| 维度 | pi | omp |
|---|---|---|
| 分帧 | 纯 JSONL | JSONL + 分片重组（`rpc_chunk`） |
| 握手 | 无 | `ready` → `negotiate_protocol` |
| 单帧上限 | `MAX_RPC_LINE_BYTES` 溢出丢弃 | 1 MB，超限走分片 |
| 超大对象 | 无处理 | 七档渐进裁剪 + 省略标注 |
| 响应关联 | `id` → pending map | 同（`id` → pending map） |

```ts
// 建议实现骨架（示意）
export class OmpRpcClient extends EventEmitter {
	private pending = new Map<string, PendingRequest>();
	private chunks = new Map<string, PendingChunks>();
	private protocolVersion: OmpRpcProtocolVersion = 1;

	/** ready 帧到达后协商协议版本；失败则保持 v1 降级 */
	async negotiate(offered: number[]): Promise<void> { /* … */ }

	/** 处理单行：区分 response / event / rpc_chunk 三类 */
	private handleLine(line: string): void {
		// rpc_chunk → 累积到 chunks，收满 count 后重组再派发
		// response + id 命中 pending → resolve
		// 其余 → emit("event", …)
	}
}
```

### 6.4 事件映射（omp → PiDeck 模型）

omp 事件形状参考 `rpc-mode.ts`（`AgentSessionEvent` 流）。映射要点：

| omp 事件 | PiDeck 目标 |
|---|---|
| 文本 delta | `ChatMessage`（assistant，流式追加） |
| reasoning delta | thinking 块（复用现有 `thinking` 展示） |
| 工具调用 start/end | `ToolCall` / `ToolResult`（对齐 `AgentMessageProjector`） |
| `get_session_stats` | `AgentRuntimeState`（tokens / context / cost） |
| `subagent_*` | 子 agent 面板（现有 `SessionSubagentsStrip`） |
| `extension_ui_request` | `agents:ui-request` 弹窗链路（Ask 卡片） |

**待实测确认：** 事件名与字段需抓真实帧后定稿（见 §8 阶段 0）。

### 6.5 会话持久化与映射

- omp 会话位于 `~/.omp/agent/sessions/`（或 `PI_CONFIG_DIR` 覆盖后的目录）
- 一期**不做**历史扫描：只映射 live 会话（与 DSH 一期策略一致，走 `list` 实时映射）
- `SessionRecord.backend = "omp"`，`agentId` 仍为 PiDeck 侧 runtime 标识

### 6.6 UI 层

- 后端选择器加 `omp` 选项（`ComposerBackendPicker`，现支持 pi/dsh 切换）
- 按 `capabilities` 隐藏 omp 不支持的操作（编辑/删除消息、rewind）
- 模型/思考档位选择器复用现有组件，数据源换成 `get_available_models`
- 用量查询：omp 有自己的 `omp-stats` 体系，一期**不复用** PiDeck 的 `usage-probes.json`

### 6.7 生命周期与安全

- omp 子进程 + Bun 进程登记进退出清理清单（`register(label, fn)`）
- 环境变量清洗：沿用 `sanitizePiChildEnv` 同类做法，并注入 `PI_CONFIG_DIR` 做隔离
- 审批/提问一律经用户确认，自动放行默认关闭

### 6.8 逐层接线对照（pi 现状 → omp 做法）

> 本节是 2026-09-22 二轮调研结果：把 pi 在 PiDeck 里的实际接线拆成四层，逐层给出 omp 的对应做法。
> 这是本计划最具可操作性的部分。

#### 层 1：可执行文件定位（`PiLocator`）

pi 的定位逻辑（`src/main/pi/PiLocator.ts`，1046 行）：

| 能力 | 现状 | omp 对应 |
|---|---|---|
| 用户自定义路径 | `customPiPath`，失效时回退自动检测 | 新增 `customOmpPath` |
| 候选目录扫描 | `getSearchDirs()` 含 npm/pnpm/yarn/volta/mise/fnm/scoop/**`~/.bun/bin`** | ✅ **`~/.bun/bin` 已在扫描列表内**，omp 由 bun 全局安装时可直接命中 |
| 版本管理器兜底 | `listChildDirs` 枚举 mise/fnm 安装树 | 可复用 |
| WSL 支持 | `wsl://` 标记 + 缓存 + 异步探测 | 一期可省略（先做本地） |
| 启动形态归一 | `createInvocation()`：`.js/.mjs/.cjs` → 用 node 启动；Windows `.cmd` shim → 还原 node + entry | ★ **同构改造**：把 `node` 换成 `bun`，其余逻辑（路径前缀、shim 还原、`shell:false`）可照搬 |

**关键复用点：** `createInvocation` 里已有一段「JS 源文件改用运行时启动」的分支：

```ts
if (/\.(?:m?js|cjs)$/i.test(command) && existsSync(command)) {
	const nodeBin = process.platform === "win32" ? "node.exe" : "node";
	return { command: nodeBin, args: [command, ...args], shell: false, pathPrefix: this.getCommandBinDir(command) };
}
```

omp 的 `dist/cli.js` 正是这种形态，只需把 `nodeBin` 换成 **bun 路径**（并补 `pathPrefix` 指向 bun 所在目录）。

#### 层 2：进程启动（`PiProcess`，916 行）

pi 的启动参数（`src/main/pi/PiProcess.ts`）：

```ts
const args = ["--mode", "rpc"];
args.push("--no-themes");
if (this.settings?.piRpcOffline !== false) args.push("--offline");
if (this.settings?.piRpcNoExtensions) args.push("--no-extensions");
if (this.settings?.piRpcNoSkills) args.push("--no-skills");
// …白名单注入 -e / --skill / --prompt-template
```

omp 对应参数（需阶段 0 实测确认标志名）：

| pi 参数 | omp 对应 | 说明 |
|---|---|---|
| `--mode rpc` | `--mode rpc` | ✅ 同名 |
| `--no-themes` | 待确认 | omp 有 TUI 主题体系，RPC 下是否可跳过需实测 |
| `--offline` | 待确认 | omp 有自己的模型目录刷新 |
| `--no-extensions` | 待确认 | |
| `--no-skills` | 待确认 | |
| `-e <path>` | `--extension <path>`？ | ★ 兼容层能否通过 `-e` 加载 pi 扩展，是阶段 0.4 的门禁项 |

**spawn 与清理（可直接照搬的模式）：**

```ts
this.proc = spawn(invocation.command, finalArgs, { /* env / cwd / shell:false */ });
this.rpc = new PiRpcClient(this.proc.stdin, this.proc.stdout);
this.rpc.on("event", …); this.rpc.on("protocol-error", …); this.rpc.on("log", …);
```

omp 侧把 `PiRpcClient` 换成 `OmpRpcClient`（分帧差异见 §6.3），其余事件接线同构。

#### 层 3：环境变量清洗（`sanitizePiChildEnv`）

pi 的做法（`PiLocator.sanitizePiChildEnv`，见 §11 证据）：

```ts
// 删除 ELECTRON_* / CHROME_* / GOOGLE_API_*；
// 清理 NODE_OPTIONS 里的 electron / asar / electron-vite 片段
```

**omp 需要额外处理：**

| 变量 | 动作 | 原因 |
|---|---|---|
| `ELECTRON_*` / `CHROME_*` | 删除 | 同 pi |
| `NODE_OPTIONS` | 清理 electron/asar 片段 | 同 pi |
| **`PI_CONFIG_DIR`** | **注入** `<userData>/omp-home` | 配置隔离（见 §3.3） |
| **`OMP_PROFILE` / `PI_PROFILE`** | 按需注入或清除 | profile 会影响 agent 目录（`~/.omp/profiles/<name>/agent`） |
| `BUN_*` | 按需保留 | Bun 自身配置（如 `BUN_INSTALL`） |

#### 层 4：网关装配（★ 最小改动点）

**这是整个集成最优雅的地方。** `src/main/index.ts:3841`：

```ts
compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager]);
```

omp 只需变成：

```ts
compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager, ompAgentManager]);
```

`CompositeAgentGateway` 的路由是**数据驱动**的（`src/main/agents/CompositeAgentGateway.ts`）：

```ts
constructor(gateways: SessionAgentGateway[], defaultBackend: AgentBackend = "pi") {
	for (const gateway of gateways) this.byBackend.set(gateway.backend, gateway);
}
// create() 按 input.backend 路由；其余按 agentId 归属路由；capabilities 取并集
```

即：**新增后端不需要改 CompositeAgentGateway 一行代码**，只要 `OmpAgentManager` 正确声明 `backend = "omp"` 与 `capabilities`。

#### 层 4b：★ 需要警惕的二元假设（真实地雷）

实测发现 **10 处**把后端硬编码成二选一：

```ts
const backend = payload?.backend === "dsh" ? "dsh" : "pi";
```

（分布：`src/main/ipc/systemIpc.ts` 6 处、`src/main/config/ConfigManager.ts` 若干、渲染层若干）

**后果：** 传 `"omp"` 进去会被**静默降级为 `"pi"`**，导致用量查询/配置读写指向错误的链路，且不报错。

**处置：** 加 `"omp"` 时必须逐处审计这类三元表达式，改为白名单校验：

```ts
const backend = payload?.backend === "dsh" ? "dsh" : payload?.backend === "omp" ? "omp" : "pi";
```

或抽公共 `normalizeAgentBackend(value): AgentBackend` 收敛（推荐，避免下次加后端再踩）。

#### 层 5：会话扫描与目录（`SessionCatalog` / `SessionScanner`）

pi 的会话是 JSONL（`~/.pi/agent/sessions/<encoded>/*.jsonl`），PiDeck 有完整 scanner。

DSH 的处理方式（可作 omp 参照）：`src/main/sessions/SessionCatalog.ts:135`

```ts
export function canAttachRuntimeMetadata(entry, tab): boolean {
	// DSH 的 sessionPath 是 host zstd 日志，不是 pi JSONL。走文件配对会把 zstd
	// 写进 filePath，渲染层当成有历史去读，空会话输入时整页抽成「正在加载历史」。
	if (entry.backend === "dsh" || tab.backend === "dsh") return false;
	…
}
```

**omp 应对齐 DSH 的保守策略：** 一期不做会话文件扫描，`canAttachRuntimeMetadata` 对 `"omp"` 返回 `false`，避免把 omp 的会话格式误当 pi JSONL 读。

#### 层 6：设置项接线

pi 的设置项（`src/shared/types/settings.ts`）：`customPiPath` / `piRpcOffline` / `piRpcNoExtensions` / `piRpcNoSkills`

omp 建议新增（保守起步）：

```ts
customOmpPath: string;      // 自定义 omp 路径（留空自动检测）
ompRpcOffline: boolean;     // 是否跳过模型目录网络刷新
ompConfigDir: string;       // PI_CONFIG_DIR 覆盖值（留空用 <userData>/omp-home）
```

**向后兼容：** 新字段必须有默认值（空串 / `true`），旧 settings.json 无需迁移。

#### 层 7：Bun 运行时解析（omp 独有，pi 没有对应层）

pi 依赖用户已装 Node（`createInvocation` 用 PATH 里的 `node`）。

omp 需要 **Bun**，且必须是 ≥1.3.14。建议策略：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 用户 PATH 里的 `bun` | 已装 Bun 的用户直接用 |
| 2 | `~/.bun/bin/bun` | ★ `PiLocator.getSearchDirs()` 已含此目录 |
| 3 | PiDeck 随包/按需下载的 Bun | 兜底，保证开箱可用 |

**注意：** 需校验版本 ≥1.3.14，低于则明确报错而不是让 omp 神秘失败。

---

## 7. 能力对照表（Parity）

### P0 — 等价能力（omp 后端可用性的必要条件）

| # | 能力 | omp RPC | 状态 |
|---|---|---|---|
| O01 | 创建会话 | `new_session` / 启动参数 | ✅ |
| O02 | 发送提示词 | `prompt` | ✅ |
| O03 | 流式接收回复 | 事件流（待抓帧确认） | ⚠️ 待验证 |
| O04 | 中止回合 | `abort` | ✅ |
| O05 | 获取运行时状态 | `get_state` | ✅ |
| O06 | 获取消息列表 | `get_messages` / `get_messages_page` | ✅ |
| O07 | 切换模型 | `set_model` | ✅ |
| O08 | 列出可用模型 | `get_available_models` | ✅ |
| O09 | 思考档位 | `set_thinking_level` | ✅ |
| O10 | 手动压缩 | `compact` | ✅ |
| O11 | 重命名会话 | `set_session_name` | ✅ |
| O12 | 协议握手 | `ready` + `negotiate_protocol` | ✅ |
| O13 | 进程退出与清理 | — | 需实现 |

### P1 — 降级 / 可选项（能力声明缺失，UI 隐藏）

| # | 能力 | 结论 |
|---|---|---|
| O14 | 编辑历史消息 | ❌ 无对应 RPC，声明缺失 |
| O15 | 删除历史消息 | ❌ 同上 |
| O16 | rewind / checkpoint | ⚠️ **二轮修正**：omp 有 `checkpoint` / `rewind` **agent 工具**（`tools/checkpoint.ts`，见 `tools/builtin-names.ts`），但**无对应 RPC 命令**——即模型可调用，宿主不能直接驱动。PiDeck 的 rewind 面板需另找对接方式（或一期不接） |
| O17 | fork 会话 | ⚠️ 有 `branch`，语义待核（可能不等于 pi 的 fork） |
| O18 | 导出 HTML | ✅ `export_html` |
| O19 | 会话内命令列表 | ✅ `get_available_commands` |
| O20 | 热重载配置 | ❌ 无 `reload_config` |
| O21 | 图片附件 | ⚠️ `prompt` 带 `images` 字段，但端到端待验证 |

### P2 — omp 特有加分项（后置）

| # | 能力 | 说明 |
|---|---|---|
| O22 | 子 agent 面板 | `get_subagents` / `subagent_event`，PiDeck 已有 `SessionSubagentsStrip` 可对接 |
| O23 | host tools 桥 | `set_host_tools` —— 可让 PiDeck 向 omp 注册宿主工具 |
| O24 | host URI 桥 | `set_host_uri_schemes` —— 可注册 PiDeck 自定义协议 |
| O25 | 消息游标分页 | `get_messages_page` —— 优于 pi 的全量 `get_messages` |
| O26 | ACP 模式 | `--mode acp` —— 通用协议，未来可能降低适配成本 |
| O27 | 自动重试开关 | `set_auto_retry` —— 可能免去 PiDeck 的 retry 扩展 |

---

## 8. 落地路线（阶段与验收门禁）

> **阶段 0 是决策门禁**：未通过则不投入后续阶段。

### 阶段 0：可行性探针（1–2 天，不碰产品代码）

| 步 | 内容 | 验收 |
|---|---|---|
| 0.1 | 安装 Bun（`brew install bun` 或 npm `bun` 包） | `bun --version` ≥ 1.3.14 |
| 0.2 | 安装 omp（`bun install -g @oh-my-pi/pi-coding-agent`） | `omp --version` 输出 18.x |
| 0.3 | 抓 `omp --mode rpc` 真实帧 | 拿到 `ready` 帧 + 协商结果 + 一次完整 prompt 事件流 |
| 0.4 | 用 `--extension` 加载一个 PiDeck 扩展（建议 `pi-deck-todo.ts`） | 加载无报错，且扩展逻辑生效 |
| 0.5 | 确认会话/配置目录可被 `PI_CONFIG_DIR` 隔离 | 目录落到指定位置，不写用户 `~/.omp` |

**门禁：** 0.3 与 0.4 必须通过。若 0.4 失败（兼容层不可用），成本回到「重写全套扩展」，本计划需重估。

### 阶段 1：最小后端 PoC（1 周）

| 步 | 内容 | 验收 |
|---|---|---|
| 1.1 | `src/main/omp/ompFrame.ts`：分片重组纯函数 + 单测 | 单测覆盖分片/超帧/乱序/缺失 |
| 1.2 | `OmpRpcClient`：握手 + 请求响应 + 事件派发 | 能跑通 `get_state` |
| 1.3 | `OmpProcess`：spawn bun + omp，退出处理 | 进程可起可停，退出不泄漏 |
| 1.4 | 探针脚本 `scripts/omp-embed-probe.mjs`（不入产品） | `npm run probe:omp` 跑通一次 prompt |

### 阶段 2：网关接入（1–2 周）

| 步 | 内容 | 验收 |
|---|---|---|
| 2.1 | `AgentBackend` 加 `"omp"`，全仓库 72 处分支逐一处理 | typecheck 绿，pi/dsh 无回归 |
| 2.2 | `OmpAgentManager` 实现 `SessionAgentGateway` | 契约测试通过 |
| 2.3 | `CompositeAgentGateway` 路由 omp | 三种后端可共存 |
| 2.4 | 事件投影 `ompEventProjector` | 流式渲染正确 |

### 阶段 3：Bun 分发与打包（1 周）

| 步 | 内容 | 验收 |
|---|---|---|
| 3.1 | `scripts/pack-omp-runtime.mjs`（对标 `pack-dsh-runtime.mjs`） | 产出三平台 tarball + 索引 |
| 3.2 | `OmpRuntimeManager`：随包 / 按需下载 + sha256 校验 | 两条路径都可用 |
| 3.3 | `extraResources` 配置 + 打包验证 | `npm run pack` 通过，产物可启动 |

### 阶段 4：UI 与能力集（1 周）

| 步 | 内容 | 验收 |
|---|---|---|
| 4.1 | 后端选择器加 omp | 可切换 |
| 4.2 | 按 capabilities 隐藏不支持操作 | 无死按钮 |
| 4.3 | 模型/思考档位接入 | 可切换并生效 |

---

## 9. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **Bun 分发复杂**（三平台 × 双架构 + 原生依赖） | 高 | 复用 `pack-dsh-runtime.mjs` 模式；阶段 0 先验证单平台 |
| **协议漂移**（omp 18.x、634 版本，迭代极快） | 高 | 锁定版本；分帧层独立可测；协商失败降级 v1 |
| **兼容层语义不符**（API 表面兼容 ≠ 行为一致） | 高 | 阶段 0.4 必须实测；逐扩展验证 |
| **分帧实现 bug**（分片/裁剪边界） | 中 | `ompFrame.ts` 抽纯函数 + 完整单测 |
| **`branch` 语义 ≠ `fork`** | 中 | 阶段 0 实测；不确定则声明能力缺失 |
| **配置隔离影响用户已有 omp 配置** | 中 | 提供导入入口；文档说明 |
| **`AgentBackend` 72 处分支遗漏** | 中 | 按文件清单逐项核对；typecheck 兜底 |
| **omp 上游停止维护或大改协议** | 低 | 阶段 0 门禁前置；不投入 C 档 |

---

## 10. 测试策略

| 层 | 内容 |
|---|---|
| 纯函数单测 | `ompFrame.ts`：分片重组、超帧裁剪、乱序、缺失分片、协商降级 |
| 协议单测 | `OmpRpcClient`：握手、响应关联、事件派发、stdout 污染容错 |
| 网关契约 | `OmpAgentManager` 对 `SessionAgentGateway` 的契约测试（对标现有 dsh 测试） |
| 能力集 | 断言 omp 的 `capabilities` 恰好为 `{compact, exportHtml, getCommands}` |
| 回归 | pi / dsh 现有测试全绿 |
| 打包 | `npm run pack` 后启动 smoke |
| E2E | 复用 `e2e/mock-pi-fixture.ts` 模式，新增 mock omp fixture |

---

## 11. 参考（证据文件索引）

> 以下为调研时核查的 omp 18.2.7 源码位置（npm tarball 内），仅作证据留存；产品实现以 PiDeck 锁定版本为准。

- 包元信息：`package/package.json`（`bin.omp`、`engines.bun`、`dependencies`）
- RPC 模式：`package/src/modes/rpc/rpc-mode.ts`（头注释「Used for embedding」）
- 分帧协议：`package/src/modes/rpc/rpc-frame.ts`（`MAX_RPC_FRAME_BYTES`、`SHRINK_PASSES`）
- 协议类型：`package/src/modes/rpc/rpc-types.ts`（`ready`、`negotiate_protocol`、命令全集）
- stdin 输入：`package/src/modes/rpc/rpc-input.ts`（`Bun.stdin.stream()`）
- 消息分页：`package/src/modes/rpc/rpc-messages.ts`（游标 + 结构化错误码）
- pi 扩展兼容：`package/src/extensibility/plugins/legacy-pi-compat.ts`（`PI_SCOPE_ALIASES`）
- 兼容 shim：`package/src/extensibility/{legacy-pi-ai,legacy-pi-coding-agent,legacy-pi-tui}-shim.ts`
- CLI 模式枚举：`package/src/cli/args.ts`（`Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui"`）
- 会话路径：`package/src/session/session-paths.ts`、`session-migrations.ts`、`foreign-session-import.ts`
- 配置目录：`@oh-my-pi/pi-utils` 的 `src/dirs.ts`（`CONFIG_DIR_NAME = ".omp"`、`PI_CONFIG_DIR`）
- 模型配置：`package/src/config/models-config.ts`、`models-config-schema.ts`
- PiDeck 侧对照：`src/main/sessions/SessionRuntimeCoordinator.ts`（`SessionAgentGateway`）、`src/shared/types/agent.ts`（`AgentBackend`、`AgentGatewayCapability`）、`src/main/pi/PiRpcClient.ts`（pi 分帧对比）

---

## 12. 落地现状与偏差

> 本节为预留快照位。阶段 0 完成后回填实测结果；若结论与 §2 冲突，以本节为准。

**当前状态：** 调研完成，未立项。二轮调研（2026-09-22）已补齐 §6.8 逐层接线对照。

**二轮调研新增结论（已并入 §6.8）：**

- 网关装配是**最小改动点**：`CompositeAgentGateway` 数据驱动路由，新增后端不需改它一行。
- `PiLocator.getSearchDirs()` **已含 `~/.bun/bin`**，bun 全局安装的 omp 可直接命中。
- `PiLocator.createInvocation()` 已有「JS 文件改用运行时启动」分支，omp 只需把 `node` 换成 `bun`。
- 实测 `backend === "dsh" ? "dsh" : "pi"` 这类二元假设共 **10 处**，传 `"omp"` 会被**静默降级为 `"pi"`**（无报错）。建议抽 `normalizeAgentBackend()` 收敛。
- backend 分支实测共 **175 处**（早期估算 72 处偏低），按文件分布见 §6.8 层 4b。
- `SessionCatalog.canAttachRuntimeMetadata` 已有 DSH 的保守先例（对 `"dsh"` 返回 `false`），omp 应照搬以避免误读会话格式。

**待回填项：**

- [ ] 阶段 0.3：真实 RPC 帧样本（`ready` / 协商 / prompt 事件流）
- [ ] 阶段 0.4：PiDeck 扩展在 omp 下的实际加载结果（逐扩展）
- [ ] 阶段 0.5：`PI_CONFIG_DIR` 隔离实测
- [ ] `branch` 与 pi `fork` 的语义差异结论
- [ ] 图片附件端到端可用性
- [ ] omp 的 RPC 启动参数标志名实测（`--no-themes` / `--offline` / `--no-extensions` / `-e` 对应项）
- [ ] Bun 版本门槛（≥1.3.14）校验方式与报错文案
- [ ] Bun 分发在打包态的实测结果
