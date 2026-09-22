# omp 能力面与 PiDeck 扩展开发清单

> 配套文档：`docs/omp-agent-backend-plan.md`（接入方案与逐层接线）。
> 本文档回答一个更具体的问题：**基于 omp 已有的功能特性，PiDeck 可以扩展开发什么。**
> 证据来源：`@oh-my-pi/pi-coding-agent@18.2.7` 源码（本地解包核查，见 §5 索引）。

**状态：** 调研完成，未立项（2026-09-22）。
**读法：** §1 是能力全景，§2 是可直接落地的扩展点（按价值排序），§3 是架构级机会，§4 是明确不建议做的。

---

## 1. omp 能力全景

omp 有 **62 个功能目录**，远超「一个 coding agent CLI」的范畴。按能力域归类：

### 1.1 会话与回合（session/）

```text
agent-session.ts        会话主体（切换、分支、恢复）
compaction-methods.ts   压缩策略
checkpoint-entries.ts   检查点条目
branch / new_session / switch_session  （RPC）
handoff                 会话交接
```

### 1.2 子 agent 体系（vibe/ + registry/ + modes/rpc/rpc-subagents.ts）

omp 的一等公民能力，有**三级订阅**：

```ts
export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string; index: number; agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string; status: AgentProgress["status"];
	task?: string; assignment?: string;
	sessionFile?: string; lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}
```

RPC 帧：`subagent_lifecycle` / `subagent_progress` / `subagent_event`
查询：`get_subagents` / `get_subagent_messages`（带 `fromByte` 增量读取）

### 1.3 工具集（tools/，约 60 个）

| 类别 | 工具 |
|---|---|
| 文件 | `read` / `write` / `edit` / `ast-edit` / `ast-grep` / `glob` / `grep` / `jfind` |
| 执行 | `bash` / `bash-interactive` / `eval` / `run-code` / `xdev` |
| 浏览器 | `browser` / `puppeteer` / `computer`（含 aria 快照） |
| GitHub | `gh` / `gh-pr-checkout` / `gh-pr-diff` / `gh-run-watch` / `gh-search` |
| 会话 | `checkpoint` / `rewind` / `todo` / `think` / `yield` / `learn` |
| 媒体 | `image-gen` / `tts` / `read-pdf` / `read-sqlite` / `read-archive` |
| 协作 | `ask` / `approval` / `report-tool-issue` |
| 其它 | `fetch` / `vibe` / `security-scan` / `debug` |

### 1.4 语言智能

| 能力 | 目录 | 说明 |
|---|---|---|
| **LSP** | `lsp/` | 真实语言服务器：诊断、跳转、格式化、批量编辑 |
| **DAP** | `dap/` | 调试适配器：断点、单步、变量查看 |

这是 omp 与 pi 最显著的差异之一 —— 它有**内置的 IDE 级能力**。

### 1.5 记忆与学习

| 能力 | 目录 | 说明 |
|---|---|---|
| Hindsight 记忆 | `hindsight/` | 外部记忆服务（`retain` / `recall` / `reflect`），可选 Cloud 或自托管 |
| mnemopi | `mnemopi/` | 本地嵌入向量（独立 subprocess，父子进程协议） |
| memories | `memories/` | 本地记忆存储 |
| autolearn | `autolearn/` | 实验性自动学习（订阅会话事件流） |
| sharpshooter | `sharpshooter/` | 提取 + 合并 + 调度 |
| speculation | `speculation/` | 推测执行 |
| advisor | `advisor/` | 顾问模型（per-session 策略门控 + 预算） |

### 1.6 智能档位与判定

| 能力 | 目录 | 说明 |
|---|---|---|
| auto-thinking | `auto-thinking/` | **按提示词难度自动选思考档位**（分类器） |
| judgment | `judgment/` | 类型化判定（`judge` 模型角色） |
| compress | `compress/` | 把文本压成「密集提示词寄存器」 |

### 1.7 协作与远程

| 能力 | 目录 | 说明 |
|---|---|---|
| collab | `collab/` | 协作房间托管（`/collab`，room rotation） |
| irc | `irc/` | IRC 集成 |
| ssh | `ssh/` | 远程执行 |
| auth-broker / auth-gateway | `cli/` | 认证代理与网关 |

### 1.8 宿主桥（★ 对 PiDeck 最关键）

omp 的 RPC 明确支持**双向宿主扩展**：

```ts
// 宿主 → omp：注册工具与 URI scheme
| { type: "set_host_tools"; tools: RpcHostToolDefinition[] }
| { type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }

// omp → 宿主：调用请求 / 增量更新 / 完成
export interface RpcHostToolCallRequest {
	type: "host_tool_call"; id: string;
	toolCallId: string; toolName: string;
	arguments: Record<string, unknown>;
}
export interface RpcHostToolUpdate { type: "host_tool_update"; id: string; partialResult: ... }
export interface RpcHostToolResult { type: "host_tool_result"; id: string; result: ...; isError?: boolean }
```

```ts
export interface RpcHostToolDefinition {
	name: string; label?: string; description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	loadMode?: ToolLoadMode;
	readsSkillUris?: boolean;
}
```

**含义：PiDeck 可以把自己的能力「反向注入」给 omp**，让 omp 的 agent 调用 PiDeck 的宿主工具（如打开文件、切换会话、触发 UI）。

### 1.9 其它

`goals/`（目标追踪）、`plan-mode/`（含 `approved-plan` / `plan-handoff`）、`activity/`（活动行）、`live/`、`stats/`、`telemetry-export-otlp.ts`（OpenTelemetry）、`stt/` + `tts/`（语音）、`secrets/`、`security/`、`markit/`、`registry/`（agent 注册表）。

---

## 2. 可直接落地的扩展点（按价值排序）

> 判据：① omp 有现成 RPC/协议；② PiDeck 有对应 UI 落点；③ 对用户可感知。

### ★★★ E1. 子 agent 实时面板（最高价值）

| 项 | 内容 |
|---|---|
| omp 侧 | `get_subagents` + `set_subagent_subscription: "events"` + `subagent_progress` / `subagent_event` 帧 |
| PiDeck 侧 | **已有** `SessionSubagentsStrip.tsx`（含状态徽章、折叠、失败态） |
| 工作量 | 小——只需把 omp 的 `RpcSubagentSnapshot` 投影成现有 entry 结构 |
| 价值 | omp 的编排能力是它的核心卖点，PiDeck 现在只有 pi 的 `derivedSubagents` 近似物 |

**omp 的 snapshot 字段与 PiDeck 现有结构高度吻合：**

```text
id / status / description / task / sessionFile / progress / parentToolCallId
        ↓ 直接映射
SessionSubagentsStrip 的 entry（id / status / label / detail / …）
```

`get_subagent_messages` 带 `fromByte` 增量游标 —— 可以做**子 agent 会话的实时流式预览**，这是 pi 侧没有的能力。

### ★★★ E2. 宿主工具反向注入（架构级机会）

| 项 | 内容 |
|---|---|
| omp 侧 | `set_host_tools` 注册 + `host_tool_call` / `host_tool_update` / `host_tool_result` 双向帧 |
| PiDeck 侧 | 需要新写工具实现层（无现成对应物） |
| 工作量 | 中 |
| 价值 | **让 omp 的 agent 能调用 PiDeck 的能力**，例如： |

可注入的候选工具：

| 工具名 | 作用 | PiDeck 侧实现 |
|---|---|---|
| `pideck_open_file` | 在 PiDeck 编辑器打开文件 | `workspace.openFile` |
| `pideck_switch_session` | 切到指定会话 | `selectSession` |
| `pideck_git_status` | 取当前仓库状态 | `GitService.status` |
| `pideck_list_projects` | 列出已注册项目 | `ProjectStore` |
| `pideck_show_diff` | 在抽屉里展示 diff | `onDiffFile` |
| `pideck_notify` | 桌面通知 | `Notification` |

**注意**：`host_tool_update` 支持增量结果，可以做**流式工具输出**（如长命令边跑边显示）。

### ★★ E3. LSP 诊断面板

| 项 | 内容 |
|---|---|
| omp 侧 | `lsp/`（`diagnostics.ts` / `diagnostics-ledger.ts` / `deferred-diagnostics.ts`） |
| PiDeck 侧 | 无现成对应；可放右侧抽屉新面板 |
| 工作量 | 中（需先确认 LSP 诊断是否经 RPC 暴露） |
| 价值 | 把 IDE 级诊断带进 PiDeck，与 Git 面板并列 |

**待验证**：LSP 是否只在 omp 进程内消费，还是有 RPC 出口。若没有，可用 `host_uri` 桥间接暴露。

### ★★ E4. 检查点 / 回退面板对齐

| 项 | 内容 |
|---|---|
| omp 侧 | `checkpoint` / `rewind` **agent 工具**（`tools/checkpoint.ts`，`tools/builtin-names.ts` 有登记） |
| PiDeck 侧 | **已有** `RewindPanel.tsx` + `RewindCheckpointList.tsx`（当前仅 pi 后端） |
| 工作量 | 中 |
| 障碍 | ⚠️ omp 的 checkpoint/rewind 是**工具**而非 **RPC 命令** —— 模型能调，宿主不能直接驱动 |

**可能的对接方式：**

1. 让 PiDeck 通过 `prompt` 触发（如发 `/rewind` 斜杠命令）
2. 从会话事件流里**观察** checkpoint 状态（`checkpoint-entries.ts` 是持久化条目）
3. 一期不接，UI 按能力隐藏（`capabilities` 不含 `rewind`）

### ★★ E5. 内置浏览器与 PiDeck 浏览器面板联动

| 项 | 内容 |
|---|---|
| omp 侧 | `tools/browser/`（含 `cmux` / `aria` / `attach`）+ `puppeteer` + `computer` |
| PiDeck 侧 | **已有** `BrowserSurface.tsx`（webview 面板） |
| 工作量 | 中 |
| 价值 | omp 的浏览器工具与 PiDeck 的 webview 是**两套独立浏览器**；可考虑让 omp 复用 PiDeck 的 webview 实例（或反之，把 omp 的截图流投到面板） |

**风险**：omp 自带 puppeteer-core（依赖 25.3.0），与 PiDeck 的 webview 是不同技术栈，强行统一可能得不偿失。

### ★ E6. 记忆后端可视化

| 项 | 内容 |
|---|---|
| omp 侧 | `hindsight/`（Cloud / 自托管）+ `mnemopi/`（本地嵌入）+ `memories/` |
| PiDeck 侧 | 无现成对应 |
| 工作量 | 中 |
| 价值 | 记忆内容对用户是黑盒；可做「查看/编辑/清除记忆」面板 |

**omp 的 memory.backend 是三选一**（`off` / `local` / `hindsight`），配置在 `~/.omp/config.yml`。PiDeck 可提供可视化配置入口。

### ★ E7. auto-thinking 档位可视化

| 项 | 内容 |
|---|---|
| omp 侧 | `auto-thinking/`（按提示词难度分类，映射到 thinking level） |
| PiDeck 侧 | **已有** 思考档位选择器（`ModelThinkingChip`） |
| 工作量 | 小 |
| 价值 | 展示「本次为什么选了这个档位」，把黑盒变透明 |

### ★ E8. 活动行 / 统计面板

| 项 | 内容 |
|---|---|
| omp 侧 | `activity/`（`AgentActivityRow`）+ `stats/` + OpenTelemetry 导出 |
| PiDeck 侧 | **已有** `UsageStatsTab`（用量统计页） |
| 工作量 | 小-中 |
| 价值 | omp 的活动行可直接喂进 PiDeck 现有统计视图 |

---

## 3. 架构级机会

### 3.1 host URI 桥：PiDeck 自定义协议

omp 支持注册 URI scheme：

```ts
export interface RpcHostUriSchemeDefinition {
	scheme: string;              // 如 "pideck"
	description?: string;
	// write 工具是否允许向该 scheme 派发写入
}
```

**可做的事：** 注册 `pideck://` scheme，让 omp 的 `read` / `write` 工具能直接访问 PiDeck 的虚拟资源：

```text
pideck://session/<id>/messages     当前会话消息
pideck://project/<id>/files        项目文件树
pideck://git/diff                  当前 diff
pideck://settings/models           模型配置
```

这比「注册一堆 host tool」更优雅——**复用 omp 现成的 read/write 工具语义**。

### 3.2 三层扩展注入的取舍

PiDeck 对 pi 用的是 `-e <path>` 注入 13 个内置扩展。对 omp 有三条路：

| 方式 | 机制 | 优势 | 劣势 |
|---|---|---|---|
| **A. `-e` 注入 pi 扩展** | omp 的 `legacy-pi-compat` 用 Babel 改写 `@earendil-works/*` 导入 | 零重写；复用现有 13 个扩展 | ⚠️ API 表面兼容 ≠ 语义一致，需逐个实测 |
| **B. host tools 注入** | `set_host_tools` | 协议级、稳定、跨版本 | 需为每个能力写工具定义；不覆盖事件钩子 |
| **C. 写 omp 原生扩展** | omp 的 `extensibility/extensions` | 最贴合 omp 语义 | 等于维护第二套扩展体系 |

**建议：优先 A（验证成本最低），B 用于宿主专属能力，C 仅在 A/B 都不行时考虑。**

### 3.3 ACP 模式作为备选协议

omp 有 `--mode acp`（Agent Client Protocol）。ACP 是通用协议（Zed 等编辑器在用），若生态成熟，**长期可能比 omp 私有 RPC 更稳定**。

**权衡：**

| | `--mode rpc` | `--mode acp` |
|---|---|---|
| 能力覆盖 | 全（含 host tools / subagent / URI） | 需评估 |
| 协议稳定性 | omp 私有，随版本变 | 通用标准 |
| 适配成本 | 需写分帧 client | 需写 ACP client + 映射层 |

一期建议仍用 `--mode rpc`（能力最全），把 ACP 作为二期评估项。

---

## 4. 明确不建议做的

| 项 | 理由 |
|---|---|
| 用 PiDeck 的 usage-probes 接 omp 用量 | omp 自带 `stats/` + `omp-stats` 包，另起一套会重复且易漂移 |
| 把 omp 的 TUI 组件搬进 PiDeck | 违反「omp 的事由 omp 做」；且 pi-tui 与 React 技术栈不通 |
| 复刻 omp 的 LSP/DAP 实现 | omp 已实现，PiDeck 应做「展示」而非「重造」 |
| 统一 omp puppeteer 与 PiDeck webview | 技术栈不同，收益不抵成本 |
| 为 omp 单独维护第二套技能/提示词体系 | 优先走 `-e` 兼容层复用现有体系 |
| 支持 omp 全部 60+ 工具的自定义 UI | 只做高频工具（read/write/bash/edit/browser）的特化展示，其余走通用卡片 |

---

## 5. 参考（证据文件索引）

> omp 18.2.7 源码位置（本地解包核查）：

- **能力目录清单**：`package/src/`（62 个目录，见 §1）
- **子 agent**：`package/src/modes/rpc/rpc-types.ts` L161-176（`RpcSubagentSnapshot`）、L345-359（三个 subagent 帧）
- **宿主工具桥**：`package/src/modes/rpc/rpc-types.ts` L442-483（定义与三个帧）、`package/src/modes/rpc/host-tools.ts`（适配器实现）
- **host URI**：`package/src/modes/rpc/rpc-types.ts` L489+（`RpcHostUriSchemeDefinition`）
- **checkpoint / rewind**：`package/src/tools/checkpoint.ts`、`package/src/tools/builtin-names.ts` L15-16、`package/src/tools/index.ts` L46/L522-523
- **LSP**：`package/src/lsp/`（diagnostics / clients / edits）
- **DAP**：`package/src/dap/`（client / session / types）
- **记忆**：`package/src/hindsight/`、`package/src/mnemopi/`、`package/src/memories/`
- **auto-thinking**：`package/src/auto-thinking/`
- **浏览器工具**：`package/src/tools/browser/`、`package/src/tools/puppeteer/`、`package/src/tools/computer/`
- **协作**：`package/src/collab/`、`package/src/irc/`、`package/src/ssh/`
- **PiDeck 侧对应物**：`src/renderer/src/components/session/SessionSubagentsStrip.tsx`、`src/renderer/src/components/workspace/RewindPanel.tsx`、`src/renderer/src/components/workspace/BrowserSurface.tsx`、`src/renderer/src/config/UsageStatsTab.tsx`

---

## 6. 优先级建议

| 阶段 | 扩展点 | 依赖 |
|---|---|---|
| **一期**（随最小后端） | E1 子 agent 面板 | 阶段 0 门禁通过 |
| **一期** | E7 auto-thinking 可视化 | 同上 |
| **二期** | E2 宿主工具注入 | 一期稳定后 |
| **二期** | 3.1 host URI 桥 | 同 E2 |
| **三期** | E3 LSP 诊断面板 / E4 rewind / E6 记忆面板 | 视用户反馈 |
| **观望** | 3.3 ACP 模式迁移 | omp 生态成熟度 |
