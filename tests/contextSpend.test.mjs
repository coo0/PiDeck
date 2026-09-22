import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { consumeTokenDelta, formatSpendCount, contextRingLevel, contextLeftPercent, contextRingAngleDeg, showContextWarnArc, CONTEXT_WARN_LEFT_PERCENT, CONTEXT_WARN_ZONE_START_DEG, contextRingColorVars, contextLevelAttribute } = loadTsCommonJs("src/renderer/src/utils/contextSpend.ts");

/**
 * 上下文消耗检测与圆环分档。
 *
 * contextTokens 是累计值：只有相邻两帧的正向增量才是「本次消耗」。
 * 四种误报形态（首次读数 / 重复上报 / 压缩回落 / 会话切换）逐条锁死。
 */

test("首次读数（无基线）返回 null：只记基线，不动画", () => {
	assert.equal(consumeTokenDelta({ prevTokens: undefined, nextTokens: 1200, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: null, nextTokens: 1200, sessionId: "s1" }), null);
});

test("读数增长返回差值（本次消耗）", () => {
	assert.equal(consumeTokenDelta({ prevTokens: 1000, nextTokens: 2240, sessionId: "s1" }), 1240);
	assert.equal(consumeTokenDelta({ prevTokens: 0, nextTokens: 5, sessionId: "s1" }), 5);
});

test("相同读数（重复上报）返回 null：轮询/重放不重复触发", () => {
	assert.equal(consumeTokenDelta({ prevTokens: 1200, nextTokens: 1200, sessionId: "s1" }), null);
});

test("读数回落（压缩后）返回 null：仅更新基线，不触发动画", () => {
	assert.equal(consumeTokenDelta({ prevTokens: 50000, nextTokens: 8000, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: 8000, nextTokens: 0, sessionId: "s1" }), null);
});

test("会话切换返回 null：不跨会话算差（切回来也不补飞）", () => {
	assert.equal(
		consumeTokenDelta({
			prevTokens: 1000,
			nextTokens: 9000,
			prevSessionId: "s1",
			sessionId: "s2",
		}),
		null,
	);
	// 同一会话（基线归属一致）正常算差
	assert.equal(
		consumeTokenDelta({
			prevTokens: 1000,
			nextTokens: 9000,
			prevSessionId: "s1",
			sessionId: "s1",
		}),
		8000,
	);
});

test("nextTokens 缺失或非有限值返回 null", () => {
	assert.equal(consumeTokenDelta({ prevTokens: 1000, nextTokens: null, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: 1000, nextTokens: undefined, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: 1000, nextTokens: Number.NaN, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: 1000, nextTokens: Number.POSITIVE_INFINITY, sessionId: "s1" }), null);
});

test("基线非有限值返回 null（脏数据不产生巨大差值）", () => {
	assert.equal(consumeTokenDelta({ prevTokens: Number.NaN, nextTokens: 1000, sessionId: "s1" }), null);
	assert.equal(consumeTokenDelta({ prevTokens: Number.POSITIVE_INFINITY, nextTokens: 1000, sessionId: "s1" }), null);
});

test("formatSpendCount 带千分位（文案外壳交给 i18n）", () => {
	assert.equal(formatSpendCount(1240), "1,240");
	assert.equal(formatSpendCount(0), "0");
	assert.equal(formatSpendCount(999), "999");
	assert.equal(formatSpendCount(1_000_000), "1,000,000");
	// 小数读数取整（token 是整数，避免出现 1,240.4）
	assert.equal(formatSpendCount(1240.4), "1,240");
});

test("contextRingLevel 五档阈值：剩余越低越危险", () => {
	assert.equal(contextRingLevel(100), "normal");
	assert.equal(contextRingLevel(61), "normal");
	// ≤60 notice
	assert.equal(contextRingLevel(60), "notice");
	assert.equal(contextRingLevel(51), "notice");
	// ≤50 warn
	assert.equal(contextRingLevel(50), "warn");
	assert.equal(contextRingLevel(41), "warn");
	// ≤40 danger
	assert.equal(contextRingLevel(40), "danger");
	assert.equal(contextRingLevel(31), "danger");
	// ≤30 critical
	assert.equal(contextRingLevel(30), "critical");
	assert.equal(contextRingLevel(0), "critical");
});

test("contextRingLevel 对非有限值按 normal 处理（无数据不误报危险）", () => {
	assert.equal(contextRingLevel(Number.NaN), "normal");
	assert.equal(contextRingLevel(Number.POSITIVE_INFINITY), "normal");
});

test("contextRingColorVars：颜色即状态（蓝紫 / 黄橙 / 橙红三组）", () => {
	// vm 上下文对象的原型与宿主不同，deepEqual 会误报「same structure but not reference-equal」；
	// 与 modelPickerDefaultExpansion 等测试一致用 JSON 比较。
	const json = (level) => JSON.stringify(contextRingColorVars(level));
	// normal 蓝→紫
	assert.equal(json("normal"), JSON.stringify({ a: "var(--ctx-ok)", b: "var(--ctx-ok2)" }));
	// notice 与 warn 同色系（黄→橙），仅容器边框强度不同
	assert.equal(json("notice"), JSON.stringify({ a: "var(--ctx-warn)", b: "var(--ctx-warn2)" }));
	assert.equal(json("warn"), JSON.stringify({ a: "var(--ctx-warn)", b: "var(--ctx-warn2)" }));
	// danger 与 critical 同色系（橙→红）
	assert.equal(json("danger"), JSON.stringify({ a: "var(--ctx-warn2)", b: "var(--ctx-danger)" }));
	assert.equal(json("critical"), JSON.stringify({ a: "var(--ctx-warn2)", b: "var(--ctx-danger)" }));
});

test("contextLeftPercent 把 runtime 的「已用」换算成「剩余」（原型语义）", () => {
	// runtime contextPercent 是已用；圆环/数字/tooltip 都以剩余为准
	assert.equal(contextLeftPercent(0), 100);
	assert.equal(contextLeftPercent(21.6), 78.4); // 原型 state.left = 78.4
	assert.equal(contextLeftPercent(100), 0);
	// 越界钳制（pi 可上报 >100%，如缓存超窗）
	assert.equal(contextLeftPercent(112), 0);
	assert.equal(contextLeftPercent(-5), 100);
	// 非有限值按「剩余满」处理（无数据占位态）
	assert.equal(contextLeftPercent(Number.NaN), 100);
});

test("contextRingAngleDeg 按剩余画弧：78.4% → 282deg（与原型一致）", () => {
	// 原型第 616 行：ring.style.setProperty("--ring-angle", (p * 3.6) + "deg")
	assert.equal(contextRingAngleDeg(78.4), 282.24);
	assert.equal(contextRingAngleDeg(100), 360);
	assert.equal(contextRingAngleDeg(50), 180);
	assert.equal(contextRingAngleDeg(0), 0);
	// 越界钳制
	assert.equal(contextRingAngleDeg(150), 360);
	assert.equal(contextRingAngleDeg(-10), 0);
	assert.equal(contextRingAngleDeg(Number.NaN), 0);
});

test("剩余语义下弧长随消耗变短（方向不能反）", () => {
	// 这是本改动修过的真实 bug：原实现画「已用」，2.3% 占用时弧几乎为 0，
	// 看起来仍是灰环，完全丢了「颜色即状态」。
	const before = contextRingAngleDeg(contextLeftPercent(20));
	const after = contextRingAngleDeg(contextLeftPercent(60));
	assert.ok(after < before, "消耗越多（已用越大）→ 剩余越少 → 弧越短");
});

test("showContextWarnArc 只在剩余 ≤20% 时出现", () => {
	assert.equal(CONTEXT_WARN_LEFT_PERCENT, 20);
	assert.equal(showContextWarnArc(20), true);
	assert.equal(showContextWarnArc(19.9), true);
	assert.equal(showContextWarnArc(0), true);
	assert.equal(showContextWarnArc(20.1), false);
	assert.equal(showContextWarnArc(80), false);
	// 非有限值不出现（占位环不该亮预警）
	assert.equal(showContextWarnArc(Number.NaN), false);
});

test("预警弧起始角度 = 阈值 * 3.6 = 72deg（原型 --zone-start）", () => {
	assert.equal(CONTEXT_WARN_ZONE_START_DEG, 72);
});

test("contextLevelAttribute 与 contextRingLevel 同源（CSS data-level 契约）", () => {
	const levels = ["normal", "notice", "warn", "danger", "critical"];
	for (const level of levels) assert.equal(contextLevelAttribute(level), level);
});
