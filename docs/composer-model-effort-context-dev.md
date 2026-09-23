# 开发文档：底栏模型/思考档位控件 + 上下文消耗动画

> **本文件是实现的唯一权威依据。** 所有尺寸、颜色、时长、缓动、间距均为**已定稿值**，来自可交互原型
> `docs/prototypes/composer-model-effort-context.html`。实现时必须逐项对齐；如与原型冲突，以原型为准并回来更新本文件。
>
> **状态：已落地**（2026-09）。范围：**只改 composer 底栏两处**——① 模型 chip 的二级浮层；
> ② 上下文圆环配色 + 消耗动画。落地时的两处范围修正（环几何保留 14px、chip 点击是开关语义）
> 已在正文对应小节以「实现范围修正」/「原型修正」标出。
>
> 配套计划文档 `docs/composer-model-effort-context-plan.md` 已按仓库文档纪律**删除**，
> 其设计结论全部沉淀在本文件；风险与测试计划见下方 §5/§6。

---

## 0. 实现前的硬约束（先读这一节）

| 约束 | 说明 |
|---|---|
| **只写 Tailwind + shadcn** | 新样式一律用 Tailwind 原子类或 `@theme` / `@utility`；**禁止**新增手写 CSS 类到 `styles/*.css` 的 legacy 层（`AGENTS.md` CSS 双轨规则 2） |
| **颜色只取 foundation 语义 token** | 不新建调色板；档位色是本文件 §3.4 明确列出的 8 个变量（它们是**新增的语义 token**，写在 `foundation.css` 的 token 区，不是第二套视觉语言） |
| **文字色不得用 surface token** | `text-bg-*` / `text-accent` 一律禁止（`storeSuggestionChipContrast.test.mjs` 守卫） |
| **动画写进 `tailwind.css` 的 `@theme`** | 与既有 `--animate-pideck-spin` / `--animate-thinking-sweep` 同处，不新建 CSS 文件 |
| **i18n 中英同 commit** | `rendererCopy.zh-CN.ts` 与 `rendererCopy.en-US.ts` 必须同步 |
| **不新增 IPC / 不改 runtime 字段** | 两处改动都是纯渲染层，数据全部来自既有 `AgentRuntimeState` |
| **格式** | biome：tab 缩进、双引号、`lineWidth: 320`、LF |

---

## 1. 改动一：模型 chip 二级浮层

### 1.1 组件与文件落点

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/renderer/src/utils/effortSlider.ts` | **新建** | 滑块几何与吸附纯函数 |
| `src/renderer/src/utils/effortColors.ts` | **新建** | 档位 → 颜色变量映射纯函数 |
| `src/renderer/src/utils/modelEffortPopover.ts` | **新建** | 两级状态机纯函数 |
| `src/renderer/src/components/session/EffortSlider.tsx` | **新建** | 滑块组件 |
| `src/renderer/src/components/session/ModelEffortPopover.tsx` | **新建** | 浮层组件（两级视图 + 定位 + 宽度过渡） |
| `src/renderer/src/components/session/ComposerComponents.tsx` | **改动（最小）** | `ModelThinkingChip` 的 `PopoverContent` 换成 `<ModelEffortPopover>` |
| `src/renderer/src/components/session/ComposerComponents.tsx` | **改动（抽取）** | 把 `ModelPicker` 的列表主体抽成 `ModelPickerBody`，供 Dialog 与浮层共用 |

> **不要**往 `ComposerComponents.tsx`（现 1082 行）继续堆新逻辑。`ModelEffortPopover.tsx` 应 ≤ 400 行；超出则按「一级视图 / 二级视图」再拆子组件。

### 1.2 两级状态机（纯函数，必须先写测试）

```ts
// src/renderer/src/utils/modelEffortPopover.ts
export type EffortPopoverView = "closed" | "effort" | "models";
export type EffortPopoverEvent =
  | { kind: "open" }        // 点 chip
  | { kind: "toModels" }    // 点 pill
  | { kind: "pickModel" }   // 在二级选中模型
  | { kind: "escape" }      // Esc
  | { kind: "outside" };    // 外点

export function nextView(current: EffortPopoverView, event: EffortPopoverEvent): EffortPopoverView;
```

**状态转移表（唯一正确行为，逐条测）**

| current | event | next | 说明 |
|---|---|---|---|
| `closed` | `open` | `effort` | 点 chip 进一级 |
| `closed` | `toggle` | `effort` | 点 chip（开关语义，见下） |
| `effort` | `toggle` | `closed` | 再点 chip 整个关闭 |
| `models` | `toggle` | `closed` | 二级时点 chip 也是整个关闭（chip 是浮层总开关） |
| `effort` | `toModels` | `models` | 点 pill 进二级 |
| `models` | `pickModel` | `effort` | **选完自动退回一级**（不是 closed） |
| `models` | `escape` | `effort` | Esc 逐级返回 |
| `effort` | `escape` | `closed` | |
| 任意 | `outside` | `closed` | 外点一律关 |
| `effort` | `open` | `effort` | 幂等（重复触发不叠加） |
| `closed` | `escape` / `outside` | `closed` | 幂等 |

> **`toggle` 是原型修正后新增的事件**（以原型为准）：原型第 599 行是
> `$("chip").addEventListener("click", () => pop ? closePop() : openPop())`，即
> **chip 是开关**。原文档只列了幂等的 `open`，照它实现会导致「点开后再点 chip 关不掉」。
> 因此 chip 的点击派发 `toggle`，`open` 保留给「幂等打开」的非点击路径。

**为什么 `pickModel → effort` 而不是 `closed`**：用户选完模型通常接着调档位（两者强相关），退回一级可少一次点击。

### 1.3 滑块几何与吸附（纯函数）

```ts
// src/renderer/src/utils/effortSlider.ts

/** 指针 x 坐标 → 最近档位索引（源脚本 indexFromPointer 的「最近中心点」算法）。 */
export function effortIndexFromPointer(input: {
  clientX: number;
  railLeft: number;
  railWidth: number;
  count: number;
}): number;

/** 索引 → 档位 id（越界钳制）。 */
export function effortFromIndex(levels: readonly string[], index: number): string;

/** 模型切换后兜底：当前档位不在新模型集合内时回落到 fallback。 */
export function resolveEffortAfterModelChange(input: {
  current: string;
  levels: readonly string[];
  fallback: string;
}): string;
```

**吸附算法（必须与原型一致）**

```
inset = 9px                       // 圆钮半径，避免首尾档位被裁切
t     = clamp01((clientX - railLeft - inset) / max(1, railWidth - inset*2))
index = round(t * (count - 1))
```

**几何（渲染圆钮/刻度点位置，必须与吸附同源）**

```
x = inset + (index / (count - 1)) * (railWidth - inset*2)
```

> 吸附与渲染**必须共用同一组常量**。原型阶段曾出现「吸附用一个 inset、渲染用另一个」的偏差风险，已统一为 `inset = 9`。

**边界行为（逐条测）**

| 输入 | 期望 |
|---|---|
| `clientX` 在轨道左端之外 | `index = 0` |
| `clientX` 在轨道右端之外 | `index = count - 1` |
| `count = 1` | `index = 0`（不除零） |
| `railWidth = 0`（首帧未布局） | `index = 0`（不 NaN） |
| `levels` 为空 | 调用方不渲染滑块 |

**键盘映射（与源脚本一致）**

| 键 | 行为 |
|---|---|
| `ArrowLeft` / `ArrowDown` | `index - 1` |
| `ArrowRight` / `ArrowUp` | `index + 1` |
| `Home` | `0` |
| `End` | `count - 1` |

### 1.4 尺寸与视觉（逐项对齐，不得近似）

#### 浮层容器

```css
/* 定位：向上弹出；空间不足时翻转到下方（JS 判断，见 §1.5） */
position: absolute;
bottom: calc(100% + 9px);      /* 与 chip 的间距 */
overflow: hidden;
background: var(--color-bg-popover);
border: 1px solid var(--color-border-default);
border-radius: var(--radius-xl);        /* 12px */
box-shadow: var(--shadow-popover);
z-index: 60;
transition: width .22s cubic-bezier(.16,.84,.24,1),
            left  .22s cubic-bezier(.16,.84,.24,1);
```

**宽度（按视图切换，实现时用具体 px 写入以驱动过渡）**

| 视图 | 宽度 | 说明 |
|---|---|---|
| 一级 `effort` | `max-content`，钳制 `min-width: 230px` / `max-width: min(430px, calc(100vw - 40px))` | 短模型名窄、长模型名宽 |
| 二级 `models` | `452px` | 固定 |

**过渡**：`width` 与 `left` **同步过渡 220ms**，视觉上是「从中心向两侧长开」，而不是单向右扩。

> **为什么用目标宽度常量而不是 `offsetWidth`**：宽度过渡期间 `offsetWidth` 读到的是中间值，用它算 `left` 会让浮层在动画中左右抖动。二级固定 452，一级需先 `width: max-content` 量一次再写成 px。

#### 一级视图「档位」

```css
/* 容器 */
display: flex; flex-direction: column;
padding: 14px 16px 16px;

/* pill：pt/5.6 Terra max › */
display: flex; align-items: center; justify-content: center; gap: 6px;
height: 26px; min-width: 0; padding: 0 10px;
border: 0; border-radius: 999px;
background: var(--color-bg-active);
cursor: pointer; white-space: nowrap;
transition: background-color .14s ease;
/* hover */
background: var(--color-bg-hover);

/* pill 内：模型名（含厂商前缀） */
font-family: var(--font-family-mono);
font-size: var(--font-size-control);        /* 13px */
font-weight: 600;
color: var(--color-text-primary);
overflow: hidden; text-overflow: ellipsis;
/* 厂商前缀弱化 */
.prov { color: var(--color-text-tertiary); font-weight: 500; }

/* pill 内：档位名 */
flex: none;
font-family: var(--font-family-mono);
font-size: var(--font-size-control);        /* 13px */
font-weight: 500;
color: var(--lv-color, var(--color-text-tertiary));
min-width: 46px;                            /* ★ 固定宽度，见下方说明 */
text-align: center;

/* pill 内：chevron › */
flex: none; color: var(--color-text-faint);
```

> ★ **`min-width: 46px` 是必需的，不是美化。** 档位名长度不一（`off` / `high` / `xhigh` / `medium`），若宽度随文字变化，拖动改档位 → pill 变宽 → 浮层重量宽度 → **轨道在手指底下被重新定位**（原型已实测复现）。配套：宽度只在**模型变化**时重算，档位变化不重算（见 §1.5）。

#### 滑块

```css
/* 轨道 */
position: relative; width: 100%; min-width: 198px;
height: 14px; margin-top: 12px;
border-radius: 999px;
background: var(--color-bg-active);
cursor: ew-resize; touch-action: none;

/* 填充：★ 固定蓝色，不随档位变色 */
position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
background: linear-gradient(90deg,
  var(--color-info),
  color-mix(in srgb, var(--color-info) 78%, #fff 22%));
transition: width .18s cubic-bezier(.16,.84,.24,1);

/* 刻度点 */
position: absolute; top: 50%; width: 3px; height: 3px; border-radius: 50%;
background: rgba(255,255,255,.6);
transform: translate(-50%,-50%);
/* 未到达的档位 */
background: var(--color-text-faint); opacity: .65;

/* 圆钮 */
position: absolute; top: 50%; width: 18px; height: 18px; border-radius: 50%;
background: #fff;
box-shadow: 0 1px 4px rgba(0,0,0,.3),
            0 0 0 2px color-mix(in srgb, var(--color-info) 45%, transparent);
transform: translate(-50%,-50%); z-index: 2;
transition: left .18s cubic-bezier(.16,.84,.24,1), box-shadow .15s ease;
/* hover / 拖动中 */
box-shadow: 0 1px 6px rgba(0,0,0,.38),
            0 0 0 4px color-mix(in srgb, var(--color-info) 26%, transparent);
```

**滑块颜色固定为 `--color-info`，不随档位变色** —— 档位信息只由 pill 里的文字颜色承担。这样轨道是一条稳定的蓝色进度条，拖动时不会整条换色跳动。

**没有档位气泡（tips）** —— 早期版本在滑块上方显示当前档位名，已按最终决定**移除**：档位名已在 pill 内，且文字颜色已随档位变化，气泡冗余。

#### 二级视图「选择模型」

```css
/* 头部 */
display: flex; align-items: center; justify-content: space-between;
gap: 16px; padding: 11px 13px; flex: none;
/* 标题 */
font-size: var(--font-size-body);        /* 14px */
font-weight: 600; letter-spacing: -.1px;
/* 右侧动作按钮 4 个：展开全部 / 折叠全部 / 刷新 / 关闭 */
width: 26px; height: 26px;
border-radius: var(--radius-sm);
color: var(--color-text-tertiary);
/* hover */ background: var(--color-bg-hover); color: var(--color-text-primary);

/* 搜索框 */
padding: 0 13px 10px; flex: none;
/* 内层 */
display: flex; align-items: center; gap: 8px;
height: 32px; padding: 0 10px;
border-radius: var(--radius-md);
border: 1px solid var(--color-border-default);
background: var(--color-bg-input);
/* 占位文案 */ color: var(--color-text-faint);

/* 分组头（⌄ 收藏 4 ……… 余额$15.83） */
display: flex; align-items: center; gap: 6px;
width: 100%; padding: 7px 13px;
font-size: var(--font-size-control); font-weight: 500;
color: var(--color-text-secondary);
/* hover */ background: var(--color-bg-hover); color: var(--color-text-primary);
/* 数量 */ font-family: var(--font-family-mono); font-size: var(--font-size-caption); color: var(--color-text-faint);
/* 余额（右贴边） */
margin-left: auto; font-family: var(--font-family-mono);
font-size: var(--font-size-caption); font-weight: 600;
color: var(--color-success);

/* 模型行 */
display: flex; align-items: center; gap: 6px;
min-height: 30px; padding: 1px 8px;
border-radius: var(--radius-md);
cursor: pointer;
/* hover（浅绿高亮） */ background: var(--row-active);
/* 行内：收藏星 24×24；模型名 mono 13px；隐藏眼 24×24 默认 opacity 0，行 hover 时 .6；选中勾 16px */

/* 列表滚动区 */
overflow-y: auto; min-height: 0; padding-bottom: 4px;
```

**`--row-active`** 需新增为 token（明暗两套）：

| 主题 | 值 |
|---|---|
| 浅色 | `#eef2e8` |
| 暗色 | `#2b2f26` |

### 1.5 定位与宽度计算（关键实现细节）

> **实现修正（已实测）**：浮层必须 **portal 到 document.body + `position: fixed`**。
> 不能按原稿的 `absolute` 挂在 chip 宿主里——底栏祖先链上有两层 `overflow-hidden`
> （`ComposerArea` 的 `footer`、`ComposerComponents` 的 `composer-bottom-center`），
> 会把 `absolute` 浮层整个裁掉。**症状是「点 chip 完全没反应」：DOM 里存在、
> `visibility: visible`、定位正确，但屏幕上看不见。**
> 旧实现用 Radix `PopoverContent`（自带 portal）所以没这个问题；本改动自绘容器时
> 必须自己 portal。定位因此改用 `getBoundingClientRect` 相对 **viewport** 计算，
> 与既有 `SessionContextMeter` 面板同一策略（见其 positionPanel）。

```
① 挂载：portal 到 document.body + position: fixed（见上方修正）。
        定位相对 viewport，不再相对 chip 宿主。

② 宽度：
   - 一级：量一个 w-max 的内容盒（自身宽度不受浮层 width 过渡影响，
           量到的值稳定），再写成 `${w}px` 以驱动过渡。
   - 二级：直接用 452。

③ 位置：按 chip 水平居中，再在**视口**内钳制（左右各留 8px）：
   centered = anchorRect.left + anchorRect.width / 2 - w / 2
   left     = clamp(centered, 8, innerWidth - 8 - w)
   垂直：优先 bottom = innerHeight - anchorRect.top + 9（浮层贴 chip 上方）；
         上方放不下时翻转 top = anchorRect.bottom + 9。

④ 重量宽度只在模型变化时触发：
   用 lastMeasuredKey 守卫（记录上次量宽时的模型 key）。
   档位变化不重量 —— 配合 pill 档位名固定宽度，轨道才不会在拖动时漂移。

⑤ 翻转：top 空间不足时改为 trigger 下方（与既有 SessionContextMeter 的
   positionPanel 同策略，可直接参考其实现）。
```

### 1.6 指针事件（必须的健壮性处理）

```ts
// setPointerCapture 在无活动指针时会抛 NotFoundError（合成事件、极端时序）。
// 若不兜底，异常会打断后续的 apply()，表现为「一次拖动直接失效」。
try { rail.setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖动 */ }
apply(event.clientX);
```

**事件清单**

| 事件 | 行为 |
|---|---|
| `pointerdown` | 开始拖动、`setPointerCapture`（try/catch）、立即 `apply` |
| `pointermove` | 拖动中实时 `apply` |
| `pointerup` / `pointercancel` | 结束拖动（清除拖动标记） |
| `keydown` | §1.3 的键盘映射 |
| `pointerenter`（chip 宿主） | 打开浮层（若正在拖动滑块则不打开） |
| `pointerleave` | 延迟 160–170ms 关闭（容错移向浮层的路径） |
| 浮层 `pointerenter` | 取消关闭定时器 |
| 浮层 `pointerleave` | 重新排定关闭 |

**隐形桥接**：浮层底部加 `::after { bottom: -11px; height: 11px }`，让鼠标从 chip 移到浮层时不闪断。

**外点关闭**：`document` 的 `pointerdown` 捕获阶段监听；点在浮层内或 chip 内则不关。

**Esc**：走 §1.2 状态机的 `escape` 事件。

### 1.7 档位集合与当前值的来源（不得自行推断）

| 值 | 唯一来源 |
|---|---|
| 可选档位集合 | `resolveThinkingPickerLevels()`（`sessionPickerOptions.ts`），组件通过 props 接收 |
| 档位 id → 显示标签 | `THINKING_LEVELS` + i18n `thinking.levelLabel.*` |
| 当前档位 | `resolveComposerThinkingLevel()`（`utils/thinkingDisplay.ts`） |
| 模型切换 | 复用现有 `onPickModel` 回调（`useSessionPreferenceController`） |

滑块**只消费**这些值。`ThinkingPicker`（Dialog）保留给 `Ctrl+T` 与命令面板，两者消费同一份 `levels`。

### 1.8 切换模型后的档位兜底

```
若 current ∉ levels：回落到 fallback
fallback 取值优先级：模型默认档位 > levels 的中间档 > levels[0]
```

用 `resolveEffortAfterModelChange()` 实现并单测。

---

## 2. 改动二：上下文圆环配色 + 消耗动画

> **按最终交互要求实现**：复用 hover tooltip 的已用百分比 `context.percent`，圆环和右侧数字
> 使用同一份数据；圆环恢复原先的 14px 紧凑尺寸；所有状态不显示容器边框。
>
> tooltip 文案通过 `reading = t("sessionContext.used", { percent: formatPercent(percent) })`
> 生成，圆环的 `ringPercent` 直接取同一个 `context?.percent`，不再做 `100 - percent` 的剩余量换算。
> 这样 tooltip 显示「上下文已用 2.3%」时，右侧数字也显示 `2.3%`，不会再出现误导性的 `98%`。
>
> 状态色仍由 `contextRingLevel(ringPercent)` 分档并写入 `data-level`，只改变圆环双色和数字色；
> 容器保持无边框，hover 只保留轻微圆环光晕。扣血动画仍按原规则保留。

### 2.0 动画开关（外观设置 `contextSpendAnimation`）

**只做渲染层隐藏**，不参与 hook 入队、不改 CSS：

```tsx
// SessionContextMeter：关闭时元素根本不进 DOM（不是靠 CSS 隐藏）
{spendAnimationEnabled && spend.spendLabel !== null && <span data-testid="session-context-spend" … />}
```

数据流：`settings.json` → `AppSettings.contextSpendAnimation`（默认 `true`）
→ App 的 effect 写入 `contextSpendAnimationAtom` → 组件订阅。
走 atom 而非 props 是因为动画在 `useContextSpendEffects`（底栏第 5 层），
为一条外观偏好加 5 层 props 链会污染 composer 的业务契约。

**为什么不在 hook 里门控（曾经踩过的坑）**：

早期版本在 `useContextSpendEffects` 里 `if (!animationEnabled) return`，
并把它排在 `prefersReducedMotion()` **前面**。后果：

1. 一个「显示」开关去拦数据流，职责错位；
2. 系统关闭「显示动画」时（`prefers-reduced-motion: reduce`）开关被静默架空——
   用户实测「菜单上是开启的，但看不到动画」，且界面上完全看不出原因；
3. 关掉开关会连后面的基线更新一起跳过。

**另一个必需的配套修改**：`foundation.css` 的全局 reduced-motion 重置把
`animation-duration` 压成 `0.01ms`，消耗动画原本不在豁免名单里，
所以即使开关开着也看不见（实测 computed `1e-05s`）。现与 spinner / 标题滚动
同策略加入豁免——它同样是**信息反馈**（告知本次消耗多少 token），
且已有用户显式开关控制，不再叠加系统偏好二次拦截。

验证（CDP，系统 `prefers-reduced-motion: true` 环境下）：

| 动画 | computed 时长 | 说明 |
|---|---|---|
| `.animate-context-hit` | `3s` | 已豁免 ✓ |
| `.animate-thinking-sweep`（对照） | `1e-05s` | 仍按系统偏好压缩 ✓ |

### 2.1 圆环配色

```css
/* 容器：原先的 28px 点击区，不带 border */
position: relative; display: inline-flex; align-items: center; gap: 6px;
height: 28px; padding: 0 8px 0 5px;
border-radius: var(--radius-md);
background: transparent; cursor: pointer;
transition: background-color .16s ease;

/* 圆环：恢复原先 14px；弧长直接使用 tooltip 的已用百分比 */
position: relative; width: 14px; height: 14px; border-radius: 50%; flex: none;
background: conic-gradient(from -90deg,
  var(--ring-a) 0deg,
  var(--ring-b) var(--ring-angle),
  var(--ctx-track) var(--ring-angle) 360deg);

/* 2px 内孔对应原先 SVG 的 2px 描边 */
.ring::after { content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--color-bg-panel); }

/* 数字：保留在环外右侧，与 tooltip 的已用百分比同源 */
font: 700 var(--font-size-caption)/1 var(--font-family-mono);
font-variant-numeric: tabular-nums;
color: var(--color-text-primary);
```

**数据口径**：

```ts
const percent = context?.percent ?? 0;
const reading = context !== null ? t("sessionContext.used", { percent: formatPercent(percent) }) : t("sessionContext.unavailable");
const ringPercent = context?.percent ?? 0;
const ringAngle = contextRingAngleDeg(ringPercent);
// 右侧数字：与 reading 使用同一个 ringPercent
{available ? `${formatPercent(ringPercent)}%` : "--"}
```

**状态 → 色系映射**：`data-level` 只改变圆环双色与数字色，容器不设置状态边框。

| 已用百分比 | 状态 | `--ring-a` | `--ring-b` |
|---|---|---|---|
| `< 40%` | `normal` | `--ctx-ok`（蓝） | `--ctx-ok2`（紫） |
| `≥ 40%` | `notice` | `--ctx-warn` | `--ctx-warn2` |
| `≥ 50%` | `warn` | `--ctx-warn` | `--ctx-warn2` |
| `≥ 60%` | `danger` | `--ctx-warn2` | `--ctx-danger` |
| `≥ 70%` | `critical` | `--ctx-warn2` | `--ctx-danger` |

**foundation token**（明暗两套）：`--ctx-track`、`--ctx-ok`、`--ctx-ok2`、`--ctx-warn`、
`--ctx-warn2`、`--ctx-danger`。不新增第二套调色板。

`ctx-ring` 样式放在 `@layer utilities`，因为 `::after` 需要嵌套选择器展开成真实 CSS；
不要移回 `@utility`。

> **已按上游逐项照搬**（用户要求：完全照搬 `codex-context-used-meter`）。旧实现（13px/800、
> 1800ms、固定像素位移 `-10px/-52px/-72px`）已废弃——那套参数导致标签偏小、飞不远，
> 位数多时看不出位移。现全部对齐上游 `.ccm-hit-pop` 的定稿值。

> **位移已加大 3 倍**（用户反馈「移动距离有点短」）。上游的可见位移只有 0.63W：
> 12%（opacity 刚变 1）时标签已偏左 1.14W，胉眼看到的总共才 49px，扣血感太弱。
> 现只延长尾段、不动出现帧（保留「从圆环里冒出来」的观感）：
> `72%` 从 `-146%` → `-232%`，`100%` 从 `-160%` → `-286%`。
> 实测（`-1,240 tok`，宽 77px）：完全可见段 12%→72% 从 33px 增到 **99px**，
> 全程 12%→100% 从 49px 增到 **145px**（2.96x）。

```css
/* 关键帧：0%/12% 取自上游 ccm-hit-pop，72%/100% 为 PiDeck 加长版 */
@keyframes context-hit {
  0%   { opacity: 0; transform: translate(-108%, -50%) scale(.72); }
  12%  { opacity: 1; transform: translate(-114%, -51%) scale(1);   }
  72%  { opacity: 1; transform: translate(-232%, -54%) scale(1.22); }
  100% { opacity: 0; transform: translate(-286%, -55%) scale(1.34); }
}
```

> 边界已核算：最坏情况（`-1,240,000 tok`，宽 108px）飞出 327px，落点 left=794，
> 而最近的裁剪容器（`.composer` 的 `overflow-hidden`）左边界在 347——余量 2 倍以上，
> 不会被裁。标签宽度用百分比自适应，长数字飞更远但仍安全。
/* 元素（定位与上游一致：相对 meter 左缘、垂直居中） */
position: absolute; left: 0; top: 50%; z-index: 9;
font: 850 14px/1 var(--font-family-mono);   /* 上游固定 14px/850，不跟主题缩放 */
white-space: nowrap; pointer-events: none;
text-shadow: 0 0 1px rgba(255,255,255,.45);
/* 渐变文字：暖白 → 粉 → 橙 */
background: linear-gradient(92deg, #fff7ed 0%, #fecdd3 38%, #fb7185 68%, #f97316 100%);
-webkit-background-clip: text; background-clip: text;
-webkit-text-fill-color: transparent;
/* 四层发光（上游原样：1px 硬边 / 8px 投影 / 14px 粉光 / 26px 橙光） */
filter: drop-shadow(0 1px 0 rgba(0,0,0,.78))
        drop-shadow(0 3px 8px rgba(0,0,0,.58))
        drop-shadow(0 0 14px rgba(251,113,133,.56))
        drop-shadow(0 0 26px rgba(249,115,22,.24));
animation: context-hit 3000ms cubic-bezier(.16,.84,.24,1) forwards;
will-change: opacity, transform, filter;
```

> **位移用自身宽度百分比**而不是固定像素：标签越长飞得越远。
> 实测（`-1,240 tok`，自身宽 77px）：0% → -0.94W、12% → -1.14W、72% → -2.43W、100% → -3.03W
> （百分比相对未变换盒子，`scale` 收缩会让左边缘回移，故不是 1.08/2.86）。

**浅色主题**：上游的高亮暖渐变在白底上不可读，PiDeck 换深色渐变（唯一偏离上游之处，
因为上游只跑在 Codex 的深色页上）：

```css
background: linear-gradient(92deg, #9a3412 0%, #dc2626 42%, #ea580c 100%);
filter: drop-shadow(0 1px 0 rgba(255,255,255,.9))
        drop-shadow(0 3px 8px rgba(180,35,24,.34))
        drop-shadow(0 0 14px rgba(251,113,133,.42))
        drop-shadow(0 0 26px rgba(249,115,22,.2));
```

**圆环同步 pulse**（620ms，让「扣血」有主体）：

```css
@keyframes context-pulse {
  0%   { transform: scale(1); }
  28%  { transform: scale(1.22); }
  100% { transform: scale(1); }
}
/* 时长 620ms，缓动 cubic-bezier(.16,.84,.24,1) */
```

**动画注册**（`tailwind.css` 的 `@theme` 块）：

```css
@theme {
  --animate-context-hit: context-hit 3000ms cubic-bezier(.16,.84,.24,1) forwards;
  --animate-context-pulse: context-pulse 620ms cubic-bezier(.16,.84,.24,1);
  @keyframes context-hit { /* 见上 */ }
  @keyframes context-pulse { /* 见上 */ }
}
```

> 兜底超时也必须跟着改：`useContextSpendEffects.ts` 的 `CONTEXT_SPEND_ANIMATION_MS`
> 是 `3000`（上游 `SPEND_EFFECT_DURATION_MS`），否则队列会在动画播完前提前推进。

**队列策略（串行，不得并行叠加）**

```
维护 queue: string[] 与 active: HTMLElement | null
入队：queue.push(label); playNext()
playNext：
  - 若 active 非空 → 直接返回（同时只飞一条）
  - 取队首；创建元素、挂到圆环容器、active = el
  - animationend 时：移除元素、active = null、递归 playNext()
  - 兜底：setTimeout(duration + 400ms) 保证 animationend 丢失时也能推进
```

### 2.3 消耗检测（纯函数 + 去重）

```ts
// src/renderer/src/utils/contextSpend.ts

/**
 * 由相邻两次 contextTokens 读数算出「本次消耗」。
 * 返回 null 表示不应触发动画。
 */
export function consumeTokenDelta(input: {
  prevTokens?: number | null;
  nextTokens?: number | null;
  prevSessionId?: string;
  sessionId: string;
}): number | null;

/** 格式化扣血标签：-1,240 tok */
export function formatSpendLabel(tokens: number): string;

/** 已用百分比 → 圆环状态（与 §2.1 的表一致） */
export function contextRingLevel(usedPercent: number): "normal" | "notice" | "warn" | "danger" | "critical";
```

**必须处理的情形（逐条测）**

| 情形 | 期望 |
|---|---|
| 首次读数（`prevTokens` 为 `null`/`undefined`） | 返回 `null`（只记基线，不动画） |
| `nextTokens > prevTokens` | 返回差值 |
| `nextTokens === prevTokens`（重复上报） | 返回 `null` |
| `nextTokens < prevTokens`（压缩后回落） | 返回 `null`（不触发，仅更新基线） |
| `sessionId` 变化 | 返回 `null`（重置基线，不跨会话算差） |
| `nextTokens` 为 `null` | 返回 `null` |
| 差值为 0 或负 | 返回 `null` |
| `formatSpendLabel(1240)` | `-1,240 tok` |

**去重窗口**：同一读数的重复上报需在窗口内去重（源脚本用 `CONTEXT_SPEND_DEDUPE_WINDOW_MS`）。实现为 `consumeTokenDelta` 内部或 hook 层的 `prevTokens` 相等判定即可——相等即不触发，无需额外时间窗。

### 2.4 `prefers-reduced-motion`

动画是**信息反馈**（告知刚消耗了多少），不是装饰。但用户显式声明减少动效时必须尊重：

```css
@media (prefers-reduced-motion: reduce) {
  /* 扣血元素：不做位移/缩放，仅短暂显示后淡出；或直接不渲染 */
}
```

**推荐做法**：`useContextSpendEffects` 内检测 `matchMedia("(prefers-reduced-motion: reduce)")`，为真时**跳过入队**（数字仍在圆环旁更新，只是不飞）。避免「静态显示一条数字然后消失」造成的视觉残留。

---

## 3. 档位颜色（8 档专属色）

### 3.1 映射

```ts
// src/renderer/src/utils/effortColors.ts
const EFFORT_COLOR_VAR: Record<string, string> = {
  off: "--lv-off", minimal: "--lv-minimal", low: "--lv-low", medium: "--lv-medium",
  high: "--lv-high", xhigh: "--lv-xhigh", max: "--lv-max", ultra: "--lv-ultra",
};

/** 档位 → CSS 变量引用；未知档位回退到次要文字色（不得返回 undefined）。 */
export function effortColorVar(effort: string): string {
  return `var(${EFFORT_COLOR_VAR[effort] ?? "--color-text-secondary"})`;
}
```

### 3.2 色值（明暗两套）

| 档位 | 浅色 | 暗色 | 观感 |
|---|---|---|---|
| `off` | `#6b7280` | `#9ca3af` | 中性灰 |
| `minimal` | `#3b82f6` | `#60a5fa` | 蓝 |
| `low` | `#4f46e5` | `#818cf8` | 靛 |
| `medium` | `#7c3aed` | `#a78bfa` | 紫 |
| `high` | `#d97706` | `#f59e0b` | 琥珀 |
| `xhigh` | `#ea580c` | `#fb923c` | 橙 |
| `max` | `#dc2626` | `#f87171` | 红 |
| `ultra` | `#b91c1c` | `#ef4444` | 深红 |

**色相从冷到暖 = 思考强度递增。**

### 3.3 硬约束

- **刻意避开绿色**：`--color-success` 是「成功」语义色，用它表达思考档位会造成误读。
- **只作用于文字**：档位色用在 pill 的档位名上（`color: var(--lv-color)`）。**滑块固定蓝色**（§1.4）。
- **明暗必须两套**：暗色整体提亮一档，保证深底上可辨识。

---

## 4. i18n 新增键（中英同步）

| key | zh-CN | en-US |
|---|---|---|
| `composerEffort.modelsTitle` | 选择模型 | Select model |
| `composerEffort.searchPlaceholder` | 搜索模型、供应商或 ID | Search models, provider, or ID |
| `composerEffort.favorites` | 收藏 | Favorites |
| `composerEffort.balance` | 余额 | Balance |
| `composerEffort.expandAll` | 展开全部 | Expand all |
| `composerEffort.collapseAll` | 折叠全部 | Collapse all |
| `composerEffort.modelCount` | {count} 模型 | {count} models |
| `composerEffort.effortLabel` | 思考强度 | Reasoning effort |
| `composerEffort.spendTokens` | -{tokens} tok | -{tokens} tok |

> 档位名沿用既有 `thinking.levelLabel.*`（**英文小写** `off/low/medium/high/xhigh/max`，与输入栏 chip 一致），不新增档位文案。

---

## 5. 验收（逐项参数核对）

**模型浮层**
- [ ] 一级浮层宽 `230–430px`，随模型名自适应；二级固定 `452px`
- [ ] 宽度与 `left` 同步过渡 `220ms cubic-bezier(.16,.84,.24,1)`
- [ ] pill 高 `26px`、圆角 `999px`、档位名 `min-width: 46px`
- [ ] 滑块高 `14px`、`min-width: 198px`、`inset: 9px`、圆钮 `18px`
- [ ] 滑块填充固定 `--color-info` 蓝色；档位文字 8 档 8 色
- [ ] 拖动吸附用 `round(t * (count-1))`，与圆钮渲染共用 `inset`
- [ ] 模型行高 `30px`；分组头 `7px 13px`；搜索框高 `32px`
- [ ] `pickModel` 后回到一级（不是关闭）
- [ ] `setPointerCapture` 有 `try/catch`

**上下文**（均已按最终要求验证）
- [x] 圆环恢复 `14px`，内孔 `inset: 2px`，数字在环外右侧
- [x] 圆环弧长和右侧数字直接使用 tooltip 同源的 `context.percent`
- [x] 5 档状态色映射与已用百分比阈值一致
- [x] 所有状态不显示容器边框
- [x] 扣血动画 `3000ms`；出现帧（0%/12%）对齐上游，尾段加长 3 倍
- [x] 扣血标签 `14px` / `850` / 四层发光 + 1px 描边（照搬上游 `.ccm-hit-pop`）
- [x] pulse `620ms`，峰值 `scale(1.22)` 在 `28%`
- [x] 队列串行；`animationend` + `setTimeout` 双保险
- [x] 压缩回落 / 重复读数 / 会话切换均不触发（纯函数单测覆盖）

---

## 6. 回归护栏

| 测试 | 守卫内容 |
|---|---|
| `tests/cssCascadeLayers.test.mjs` | 新 keyframes 在 `@theme`；未引入新层或 legacy 手写规则 |
| `tests/storeSuggestionChipContrast.test.mjs` | 档位色是文字色，未用 surface token |
| `tests/rendererProductCopyI18n.test.mjs` | 新增文案中英同步 |
| `tests/sessionRuntimeTargetBoundaries.test.mjs` | 未新增 runtime 命令（本改动不应触发） |

新增单测：`effortSlider` / `modelEffortPopover` / `contextSpend` / `effortColors`。
