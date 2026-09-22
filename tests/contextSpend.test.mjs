import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { consumeTokenDelta, formatSpendCount, contextRingLevel, contextRingLevelFromUsed, contextRingColorVars, contextRingTextColor } = loadTsCommonJs("src/renderer/src/utils/contextSpend.ts");

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

test("contextRingLevelFromUsed 把「已用」口径换算成分档（圆环越满越红）", () => {
	// 已用 40% → 剩余 60% → notice
	assert.equal(contextRingLevelFromUsed(40), "notice");
	// 已用 50% → 剩余 50% → warn
	assert.equal(contextRingLevelFromUsed(50), "warn");
	// 已用 60% → 剩余 40% → danger
	assert.equal(contextRingLevelFromUsed(60), "danger");
	// 已用 70% → 剩余 30% → critical
	assert.equal(contextRingLevelFromUsed(70), "critical");
	// 刚启动（已用 0）→ 剩余 100% → normal
	assert.equal(contextRingLevelFromUsed(0), "normal");
	// 无数据占位环（percent 兜底 0）也走 normal
	assert.equal(contextRingLevelFromUsed(Number.NaN), "normal");
});

test("contextRingTextColor：normal 用主文字色，预警/危险用状态色", () => {
	assert.equal(contextRingTextColor("normal"), "var(--color-text-primary)");
	assert.equal(contextRingTextColor("notice"), "var(--ctx-warn)");
	assert.equal(contextRingTextColor("warn"), "var(--ctx-warn)");
	assert.equal(contextRingTextColor("danger"), "var(--ctx-danger)");
	assert.equal(contextRingTextColor("critical"), "var(--ctx-danger)");
});
