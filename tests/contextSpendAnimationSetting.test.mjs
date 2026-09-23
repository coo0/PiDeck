/**
 * 上下文消耗动画开关（contextSpendAnimation）的接线测试。
 *
 * 背景：消耗动画（底栏圆环向左飞出 `-N tok`）此前无法关闭。用户要求在外观设置里
 * 加一项开关。该开关横跨四个进程层，任何一层漏改都会「看着有开关、实际不生效」：
 *
 * 1. 类型 + 三处默认值（主进程持久化 / 渲染层首屏 / 预览 mock）必须一致；
 * 2. 主进程读盘时对旧 settings.json（无此字段）回落 true，脏数据（字符串）也回落；
 * 3. update patch 必须校验类型，否则字符串会被写进 settings.json；
 * 4. App 把 settings 同步到 atom（深层的 hook 不持有 settings props）；
 * 5. hook 在入队前读开关 —— 这是唯一真正生效的位置；
 * 6. 设置页 + 命令面板锚点 + 未保存摘要 + 中英文案齐全。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const settingsType = () => read("src/shared/types/settings.ts");
const store = () => read("src/main/settings/SettingsStore.ts");
const app = () => read("src/renderer/src/App.tsx");
const preview = () => read("src/renderer/src/previewApi.ts");
const atoms = () => read("src/renderer/src/atoms/app-ui-atoms.ts");
const hook = () => read("src/renderer/src/hooks/useContextSpendEffects.ts");
const appearanceTab = () => read("src/renderer/src/components/app/settings/AppearanceTab.tsx");
const anchors = () => read("src/renderer/src/utils/settingsFieldAnchors.ts");
const summary = () => read("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
const zh = () => read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = () => read("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("contextSpendAnimation 类型与三处默认值一致（默认开启）", () => {
	assert.match(settingsType(), /contextSpendAnimation: boolean/);
	// 主进程持久化默认、渲染层首屏默认、预览 mock 三处同步（漏一处就会出现
	// 「预览里关了但真机没关」这类只有手动比对才发现的偏差）
	assert.match(store(), /contextSpendAnimation: true/);
	assert.match(app(), /contextSpendAnimation: true/);
	assert.match(preview(), /contextSpendAnimation: true/);
});

test("旧 settings.json 缺字段时回落 true，脏数据也回落", () => {
	const source = store();
	// 读盘归一化：升级用户的旧配置没有这个键
	assert.match(source, /typeof this\.settings\.contextSpendAnimation !== "boolean"\) \{[\s\S]{0,120}?this\.settings\.contextSpendAnimation = defaultSettings\.contextSpendAnimation/);
	// update patch 校验：非布尔值丢弃，不让脏数据落盘
	assert.match(source, /"contextSpendAnimation" in safePatch && typeof safePatch\.contextSpendAnimation !== "boolean"\) \{[\s\S]{0,80}?delete safePatch\.contextSpendAnimation/);
});

test("开关经 atom 同步（不为外观偏好加 5 层 props 链）", () => {
	// atom 默认 true，与 main SettingsStore.defaultSettings 一致
	assert.match(atoms(), /export const contextSpendAnimationAtom = atom\(true\)/);
	// App 从 settings 写入
	assert.match(app(), /setContextSpendAnimation\(settings\.contextSpendAnimation \?\? true\)/);
	assert.match(app(), /import \{[^}]*contextSpendAnimationAtom[^}]*\} from "\.\/atoms"/);
});

/**
 * 开关的职责边界：**只做渲染层隐藏**，不参与 hook 的入队判定。
 *
 * 曾经的设计是在 `useContextSpendEffects` 里 `if (!animationEnabled) return`，
 * 后果有三：① 一个「显示」开关去拦数据流；② 它又把 `prefers-reduced-motion`
 * 排在后面，系统关闭「显示动画」时开关被静默架空（用户实测：开关开着也没动画，
 * 且界面上看不出原因）；③ 关掉开关还会跳过后面的基线更新。
 * 现改为组件层 `hidden`，hook 保持纯数据层。
 */
test("开关在组件层隐藏元素，hook 不得再读开关", () => {
	const meter = read("src/renderer/src/components/session/SessionContextMeter.tsx");
	const h = hook();

	// 组件：订阅 atom 并门控渲染
	assert.match(meter, /const spendAnimationEnabled = useAtomValue\(contextSpendAnimationAtom\)/);
	assert.match(meter, /import \{[^}]*contextSpendAnimationAtom[^}]*\} from "\.\.\/\.\.\/atoms\/app-ui-atoms"/);
	assert.match(meter, /\{spendAnimationEnabled && spend\.spendLabel !== null && \(/);

	// hook：不得再引入开关，也不得用 reduced-motion 提前 return（它会架空开关）
	assert.doesNotMatch(h, /contextSpendAnimationAtom/);
	assert.doesNotMatch(h, /if \(!animationEnabled\) return;/);
	assert.doesNotMatch(h, /if \(prefersReducedMotion\(\)\) return;/);
});

test("关闭开关只影响显示：消耗检测、队列与圆环数字不受影响", () => {
	const h = hook();
	const meter = read("src/renderer/src/components/session/SessionContextMeter.tsx");
	// hook 仍然计算差值并入队（基线不受开关影响）
	assert.match(h, /const delta = consumeTokenDelta\(\{/);
	assert.match(h, /queueRef\.current\.push\(t\("composerEffort\.spendTokens"/);
	// 圆环数字来自 context.percent，与本开关无关
	assert.match(meter, /const ringPercent = context\?\.percent \?\? 0;/);
});

test("消耗动画被加入 reduced-motion 豁免（否则系统关动画时开关形同虚设）", () => {
	const foundation = read("src/renderer/src/styles/foundation.css", "utf8");
	const reset = foundation.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0];
	assert.ok(reset, "全局 reduced-motion 重置块必须存在");
	// 与 spinner / 标题滚动同策略：它同样是信息反馈，且有用户显式开关
	assert.match(reset, /\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\):not\(\.animate-context-hit\)/);
});

test("设置页开关、命令面板锚点、未保存摘要三处齐全", () => {
	const tab = appearanceTab();
	// 开关落在「聊天排版」区，与聊天区观感同组
	assert.match(tab, /anchor="appearance-context-spend-animation"/);
	assert.match(tab, /checked=\{draft\.contextSpendAnimation \?\? true\}/);
	assert.match(tab, /onChange=\{\(checked\) => updateDraft\(\{ contextSpendAnimation: checked \}\)\}/);
	// dirty 标记：与其它外观项一致，改了没保存要显示黄点
	assert.match(tab, /dirty=\{isDirty\("contextSpendAnimation"\)\}/);
	// 命令面板可搜到
	assert.match(anchors(), /slug: "appearance-context-spend-animation"/);
	assert.match(anchors(), /labelKey: "settings\.contextSpendAnimation"/);
	// 未保存摘要能列出
	assert.match(summary(), /\{ field: "contextSpendAnimation", tab: "appearance", itemKey: "settings\.contextSpendAnimation" \}/);
});

test("i18n 中英同步且描述说明「关闭后消耗照常」", () => {
	// 中英键必须同时存在（rendererProductCopyI18n 另有全量校验，这里锁语义）
	assert.match(zh(), /"settings\.contextSpendAnimation": "显示上下文消耗动画"/);
	assert.match(en(), /"settings\.contextSpendAnimation": "Show context spend animation"/);
	// 描述必须讲清「只关动画、不影响计数」，否则用户会以为关掉就不统计了
	assert.match(zh(), /"settings\.contextSpendAnimationDesc"[\s\S]{0,220}?消耗照常计入/);
	assert.match(en(), /"settings\.contextSpendAnimationDesc"[\s\S]{0,260}?only the animation is skipped/);
});
