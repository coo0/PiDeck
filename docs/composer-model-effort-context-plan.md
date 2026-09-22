# 开发计划：底栏模型/思考档位控件 + 上下文消耗动画

> **范围限定**：本计划**只**涉及 composer 底栏的两处改动，不触碰会话链路、模型目录、用量探针、压缩逻辑。
>
> ① **模型 chip 的二级浮层**：把现在「点 chip → 原生 Dialog 选择器」的两段式，改为「点 chip → 档位浮层（pill + 拖动滑块）→ 点 pill → 选择模型列表」，两级共用一个浮层容器。
>
> ② **上下文圆环 + 消耗动画**：圆环改为鲜明渐变配色（颜色即状态），新增「消耗 token 时从圆环向左飞出的扣血数字」动画。
>
> 基线：`custom` 分支（含未提交的 `src/shared/sessionIdentity.ts` 改动，与本计划无关）。
> 原型：`docs/prototypes/composer-model-effort-context.html`（本计划的视觉与交互唯一依据）。
> 参考实现：`codex-context-used-meter` 的 `ccm-hit-pop` 关键帧与队列策略、`Codex-Model-Matrix` 的拖动吸附算法。

**状态：未开工（计划已定稿，待评审）。**

---

## 1. 一句话诊断

两处改动都不是「加功能」，而是**把已有的正确能力换一个更好的入口和表达**：

| | 现状 | 问题 | 目标 |
|---|---|---|---|
| 模型 chip | `模型名 · 档位 ⌄` → Popover 两行菜单（模型 / 思考）→ 各自 drill-in 到 Dialog | 切档位要「点开 → 点思考 → 选 → 关」四步，而档位是高频操作；且档位不可拖动、看不到「还能调到哪」 | 一级浮层直接给 pill + 滑块，档位零弹窗完成；二级才进完整模型列表 |
| 上下文圆环 | 19px 灰环（`--color-border` + `--color-text-tertiary`），占用只靠弧长表达 | 灰环在白/深底上都接近背景色，扫一眼读不出状态；且消耗过程完全无反馈（数字跳一下而已） | 圆环用 `conic-gradient` 双色渐变，颜色即状态；消耗时从圆环向左飞出 `-N tok` |

**关键判断**：滑块是本计划的**唯一新增交互原语**。其余都是既有能力的重排与上色，因此风险集中在滑块的可达性（键盘/触摸/吸附精度）与浮层两级切换的定位，而不是数据链路。

---

## 2. 现状核查（源码证据）

### 2.1 模型 chip 与选择器

| 事实 | 位置 |
|---|---|
| chip 是 `ModelThinkingChip`，Popover 内两行按钮（模型 / 思考），各自 `drillIn` 关闭 Popover 再开 Dialog | `src/renderer/src/components/session/ComposerComponents.tsx:555-598` |
| 模型 Dialog 是 `CommandPickerDialog`（标题 + 搜索 + 折叠分组 + 收藏星/隐藏眼/选中勾 + 底部快捷键） | 同文件 `723-932`（`ModelPicker`）与 `631-680`（`CommandPickerDialog`） |
| 思考 Dialog 是 `ThinkingPicker`，档位来自 `levels` 属性 | 同文件 `935-975` |
| 两个 Dialog 的挂载与回调来自 `ComposerPickerHost`，状态在 `useSessionPreferenceController` | `ComposerPickerHost.tsx:23-82` |
| 档位可选集合的唯一判定 | `sessionPickerOptions.ts:48-60` `resolveThinkingPickerLevels()` |
| 档位 id → 本地化标签 | `sessionPickerOptions.ts:8-16` `THINKING_LEVELS` + `i18n` 的 `thinking.levelLabel.*` |
| chip 当前档位解析 | `resolveComposerThinkingLevel()`（`utils/thinkingDisplay.ts`） |

**结论**：档位列表与「当前档位」都已有权威来源，滑块**只消费**这两个值，不得自己推断档位集合。

### 2.2 上下文圆环

| 事实 | 位置 |
|---|---|
| 圆环组件、`contextOccupancy()`、`contextSegments()`、`formatTokens()` | `src/renderer/src/components/session/SessionContextMeter.tsx` |
| 占用百分比唯一判定（圆环与 `/compact` 共用） | `src/shared/compactFeedback.ts:resolveCompactUsagePercent()` |
| runtime 字段 | `AgentRuntimeState.contextPercent / contextTokens / contextWindow / contextMessageTokens / contextSystemTokens / contextToolsTokens`（`src/shared/types/agent.ts:65+`） |
| 底栏挂载点 | `ComposerComponents.tsx:510-520`（`isImageGenMode ? null : <SessionContextMeter/>`） |

**结论**：圆环是**纯展示 + 面板入口**，不新增数据字段、不新增 IPC。消耗动画所需的数据（`contextTokens` 的增量）完全来自既有 runtime state 的相邻两帧。

### 2.3 测试与规范约束

- 纯函数测试直连 `.ts` 源文件（`node --test`，见 `tests/composerSendButton.test.mjs` 的写法）。
- 格式化硬门禁：biome，`lineWidth: 320`，tab 缩进，双引号。
- CSS 双轨：**新改动只写 Tailwind + shadcn**；token 必须取 `foundation.css` 的语义变量，不新建调色板。
- 层叠顺序 `theme < base < components < vendor < legacy < utilities`，由 `tests/cssCascadeLayers.test.mjs` 守卫。
- `storeSuggestionChipContrast.test.mjs` 守卫「不得用 surface token 当文字色」。
- i18n：`rendererCopy.zh-CN.ts` 与 `rendererCopy.en-US.ts` 必须同步（`mainProcessI18n` / `rendererProductCopyI18n` 守卫）。
- 源文本契约测试：新增正则断言必须容忍空白（`\s*`）。

---

## 3. 改动一：模型 chip 二级浮层

### 3.1 目标交互

```
① 底栏 chip（不变）
   pt/deepseek-v4.1-flash · xhigh  ⌄        ← 点击
              ↓
② 一级浮层「档位」（宽随内容，230–430px）
   ┌────────────────────────┐
   │   ┌ pt/5.6 Terra max › ┐│   ← pill，点击进入二级
   │   ═════════════════●    │   ← 蓝色滑块，拖动/键盘改档位
   └────────────────────────┘
              ↓ 点 pill
③ 二级浮层「选择模型」（452px）
   ┌──────────────────────────────────────────┐
   │ 选择模型        ⇕ ⇵ ↻ ✕                  │
   │ ┌ 搜索模型、供应商或 ID ──────────────┐  │
   │ ⌄ 收藏 4                                 │
   │   ★ pt/deepseek-v4.1-flash           ✓  │
   │ › pt 8 模型                    余额$15.83│
   └──────────────────────────────────────────┘
              ↓ 选中模型
   自动退回一级浮层（pill 更新，可继续调档位）
```

### 3.2 设计要点（必须实现）

1. **两级共用一个浮层容器**，切换时宽度做过渡（`230px ↔ 452px`），不出现「关一个开一个」的闪断。
2. **宽度跟随内容**：一级浮层 `width: max-content` + `min-width` / `max-width` 钳制。模型名长短不同（`5.5` vs `claude-sonnet-4.6`）时浮层宽度自适应。
3. **定位**：以 chip 为锚点水平居中，并在应用边界内钳制（左右各留 8px）；向上弹出，空间不足时翻转到下方。
4. **选中模型后自动退回一级**（用户选完模型通常接着调档位），而不是直接关闭。
5. **Esc 逐级返回**：二级 → 一级 → 关闭。外点一律关闭。
6. **滑块**：
   - 拖动实时跟随 + 松手吸附最近档位（源脚本 `indexFromPointer` 的最近中心点算法）；
   - 键盘 `←/→`、`Home/End`；
   - `setPointerCapture` 必须 `try/catch` 兜底（无活动指针时会抛 `NotFoundError`，会打断整次拖动）；
   - 档位名**固定宽度**（`min-width: 46px`），否则拖动改档位 → pill 变宽 → 浮层重量宽度 → 轨道在手指底下漂移。
7. **档位颜色**：每个档位一个专属色，**只作用于档位文字**。滑块本身**固定蓝色**（`--color-info`），不随档位变色。
8. **切换模型后档位兜底**：若当前档位不在新模型的有效集合内，回落到该模型的默认档位。

### 3.3 落地结构（遵守「一个模块一个职责」）

新增纯函数与组件，**不往 `ComposerComponents.tsx`（1082 行）继续堆**：

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/renderer/src/utils/effortSlider.ts` | 滑块几何与吸附：`effortIndexFromPointer()`、`effortFromIndex()`、`clampEffort()`、`resolveEffortAfterModelChange()` | 纯函数（可单测） |
| `src/renderer/src/utils/effortColors.ts` | 档位 → 颜色变量名映射（`effortColorVar()`），含未知档位兜底 | 纯函数（可单测） |
| `src/renderer/src/utils/modelEffortPopover.ts` | 两级状态机：`nextView(current, event)`，事件 = `open \| toModels \| pickModel \| escape \| outside` | 纯函数（可单测） |
| `src/renderer/src/components/session/ModelEffortPopover.tsx` | 浮层组件：渲染两级视图、定位、宽度过渡、键鼠事件 | React 组件 |
| `src/renderer/src/components/session/EffortSlider.tsx` | 滑块子组件（几何消费 `effortSlider.ts`） | React 组件 |

`ComposerComponents.tsx` 的改动**仅限**把 `ModelThinkingChip` 的 `PopoverContent` 换成 `<ModelEffortPopover>`，并透传 `levels` / `onPickModel` / `onPickThinking`。

### 3.4 与现有选择器的关系

- **二级视图复用现有 `ModelPicker` 的内容**（收藏/分组/搜索/隐藏），不重写列表逻辑。优先做法：把 `ModelPicker` 的列表主体抽为 `ModelPickerBody`，让 Dialog 与 Popover 两种容器共用；**不复制一份列表代码**。
- `ThinkingPicker` 保留（快捷键 `Ctrl+T` 与命令面板仍走它），滑块是**新增的并行入口**，不是替代。两者必须消费同一份 `levels`。

### 3.5 不做（明确排除）

- 不做 Floating 悬浮模式（源脚本的右键切换/横纵布局/滚轮缩放）。
- 不做 1 小时消耗历史折线图。
- 不做模型矩阵的「族分组 + 变体标签」重排（`ModelPicker` 现有的供应商分组保持不变）。
- 不改 `THINKING_LEVELS` 的档位集合与 id。

---

## 4. 改动二：上下文圆环配色 + 消耗动画

### 4.1 目标

**圆环**：`conic-gradient` 双色渐变，颜色即状态；剩余跌破 20% 时外圈浮出斜线弧（压缩预警）。

| 剩余占用 | 圆环色系 | 文字色 |
|---|---|---|
| `> 60%` | `--color-info` → `--color-chip-skill`（蓝→紫） | 主文字色 |
| `≤ 60%` | `--color-warning` → 橙 | `--color-warning` |
| `≤ 50%` | 同上（更饱和） | `--color-warning` |
| `≤ 40%` | 橙 → `--color-danger` | `--color-danger` |
| `≤ 30%` | 同上（满强度） | `--color-danger` |

**动画**：新消耗产生时，从圆环**向左**飞出 `-1,240 tok`，放大淡出；队列串行；圆环同步 pulse。

```
   ┌──────────┐
   │  ◕ 78%   │ ← -1,240 tok ←←←←←←←←←←←←  向左 72px
   └──────────┘

   0%    opacity 0   scale .68   translateX 0
   11%   opacity 1   scale 1.0   translateX -10px
   70%   opacity 1   scale 1.2   translateX -52px
   100%  opacity 0   scale 1.32  translateX -72px

   1800ms · cubic-bezier(.16,.84,.24,1) · 队列串行
   圆环 pulse：scale 1 → 1.22 → 1（620ms）
```

### 4.2 消耗检测（必须去重）

`contextTokens` 是**累计值**，相邻两帧的差才是本次消耗。必须处理：

- **同一读数重复上报**（轮询/重放）→ 相同 `contextTokens` 不重复触发；
- **会话切换**（`sessionId` 变化）→ 重置基线，不跨会话算差；
- **压缩后回落**（`contextTokens` 变小）→ 差为负，不触发动画，仅更新基线；
- **首次读数**（无基线）→ 只记基线，不触发动画。

去重窗口与源脚本一致（`CONTEXT_SPEND_DEDUPE_WINDOW_MS`），实现为纯函数 `consumeTokenDelta(prev, next)`。

### 4.3 落地结构

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/renderer/src/utils/contextSpend.ts` | `consumeTokenDelta()`（增量 + 去重）、`formatSpendLabel()`、`contextRingLevel()` | 纯函数（可单测） |
| `src/renderer/src/hooks/useContextSpendEffects.ts` | 队列状态、串行播放、`sessionId` 变化时重置基线 | hook |
| `SessionContextMeter.tsx` | 圆环改 `conic-gradient`；挂载扣血元素与 `.hit` pulse | 改动既有组件 |
| `src/renderer/src/styles/tailwind.css` | `@theme` 新增 `--animate-context-hit` + `@keyframes context-hit` | 改动既有文件 |

**CSS 落点**：新动画写在 `tailwind.css` 的 `@theme` 块（与既有 `--animate-pideck-spin` / `--animate-thinking-sweep` 同处），不新建手写 CSS 文件、不在 legacy 层加规则。

### 4.4 不做（明确排除）

- 不改圆环尺寸（保持 19px）与数字位置（保持环外右侧）。
- 不改 `resolveCompactUsagePercent()` 的口径（圆环与 `/compact` 必须继续同源）。
- 不做 provider 余额的消耗动画（源脚本有，本计划只做 token）。
- 不改上下文面板（popover）的既有内容。

---

## 5. 测试计划

### 5.1 必写单测（新文件）

| 文件 | 断言要点 |
|---|---|
| `tests/effortSlider.test.mjs` | 指针 → 最近档位吸附；边界（左端、右端、轨道外）；档位索引 ↔ id 双向映射；模型切换后档位兜底（不在集合内则回落） |
| `tests/modelEffortPopover.test.mjs` | 状态机全事件矩阵：`open→effort`、`toModels→models`、`pickModel→effort`、`escape(models)→effort`、`escape(effort)→closed`、`outside→closed` |
| `tests/contextSpend.test.mjs` | 增量计算；相同读数不重复触发；负数（压缩回落）不触发；无基线只记基线；`sessionId` 变化重置；标签格式化（千分位、`-1,240 tok`） |
| `tests/effortColors.test.mjs` | 每个档位映射到不同颜色变量；未知档位兜底不返回 `undefined` |

### 5.2 回归护栏（必须不被破坏）

| 测试 | 为什么相关 |
|---|---|
| `tests/cssCascadeLayers.test.mjs` | 新 keyframes 写进 `@theme`，不得引入新的层或手写 legacy 规则 |
| `tests/storeSuggestionChipContrast.test.mjs` | 档位色是**文字色**，不得用 surface token（`bg-*`） |
| `tests/rendererProductCopyI18n.test.mjs` | 新增文案必须中英同步 |
| `tests/sessionRuntimeTargetBoundaries.test.mjs` | 本计划不新增 runtime 命令；若不慎引入须带 `sessionId/agentId/runtimeGeneration` 三元组 |
| `tests/sessionPickerOptions` 相关（若存在） | 档位集合判定必须继续走 `resolveThinkingPickerLevels()` |

### 5.3 门禁命令

```bash
npm run typecheck
node --test tests/effortSlider.test.mjs tests/modelEffortPopover.test.mjs tests/contextSpend.test.mjs tests/effortColors.test.mjs
npm run check:format
# 触及 CSS/i18n 时追加：
node --test tests/cssCascadeLayers.test.mjs tests/storeSuggestionChipContrast.test.mjs tests/rendererProductCopyI18n.test.mjs
```

---

## 6. 验收清单（逐条可勾）

**改动一**
- [ ] 点 chip 出现一级浮层，位置在 chip 正上方且水平居中，不越应用边界
- [ ] 一级浮层宽度随模型名长短自适应，且 `≤ 430px`（窄屏不溢出）
- [ ] 拖动滑块实时跟随，松手吸附到最近档位；拖动过程中轨道不位移
- [ ] 键盘 `←/→`、`Home/End` 可改档位，焦点可见
- [ ] 点 pill 切到二级，宽度平滑过渡（无闪断、无第二个浮层）
- [ ] 二级列表含收藏组 + 供应商组（右侧余额）+ 搜索 + 折叠 + 收藏/隐藏
- [ ] 选中模型后回到一级，pill 与 chip 同步更新
- [ ] `Esc` 逐级返回；外点关闭
- [ ] 切换模型后若原档位不支持，自动回落到有效档位
- [ ] 滑块固定蓝色；档位文字随档位变色且 8 档两两不同

**改动二**
- [ ] 圆环按剩余占用显示蓝紫 / 黄橙 / 橙红三段渐变
- [ ] 剩余 ≤ 20% 时外圈出现斜线弧
- [ ] 新消耗时从圆环向左飞出 `-N tok`，1800ms 后消失
- [ ] 连续消耗时逐条排队，不同时叠出多条
- [ ] 同一读数重复上报不重复触发
- [ ] 压缩后 `contextTokens` 回落不触发动画
- [ ] 切换会话不跨会话算差
- [ ] `prefers-reduced-motion` 下动画降级为静态（或直接跳过）

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 滑块拖动时浮层重量宽度导致轨道漂移 | 档位名固定宽度 + 仅在模型变化时重量宽度（原型已实测复现并修复） |
| `setPointerCapture` 抛异常打断拖动 | `try/catch` 兜底（原型已实测复现并修复） |
| 浮层被 composer 的 `overflow` 裁剪 | 浮层 portal 到 body（与既有 Popover 一致），定位用 `getBoundingClientRect` 相对 viewport |
| 拆分 `ModelPickerBody` 时破坏现有 Dialog 行为 | 先抽纯列表主体，Dialog 与 Popover 共用；改完跑既有模型选择器相关测试 |
| 消耗动画在长会话高频触发造成卡顿 | 队列串行 + 单元素复用；`will-change: opacity, transform` |
| 圆环配色改动影响面板可读性 | 只改圆环与数字，面板内部结构不动；`storeSuggestionChipContrast` 守卫文字色 |
| 新增文案漏了英文 | i18n 两文件同 commit 改；`rendererProductCopyI18n` 守卫 |

---

## 8. 交付顺序（每步可独立验证）

1. **纯函数 + 单测**（`effortSlider` / `modelEffortPopover` / `contextSpend` / `effortColors`）——先绿再动 UI。
2. **圆环配色 + 消耗动画**（改动二）——独立于改动一，风险最低，先落。
3. **一级浮层（pill + 滑块）**——接上纯函数，替换 `ModelThinkingChip` 的 PopoverContent。
4. **二级视图复用 `ModelPickerBody`**——抽列表主体，Dialog 与 Popover 共用。
5. **i18n 补齐 + `typecheck` + 定向测试 + 回归护栏**。
6. 文档收口：本文件状态行改为「已落地」，并在 `AGENTS.md` 无新增长期纪律时**删除**本计划（按仓库文档纪律，不留悬空计划文档）。

---

## 9. 文档纪律

按 `AGENTS.md`「长期重构纪律」：计划文档落地后必须收口——更新状态行或删除，不留长期悬空。本文件在第 8 步第 6 项完成后删除，其**不可变的设计结论**全部沉淀进 `docs/composer-model-effort-context-dev.md`。
