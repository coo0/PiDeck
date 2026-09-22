import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { effortColorVar, hasEffortColor } = loadTsCommonJs("src/renderer/src/utils/effortColors.ts");

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

/** 8 个档位（与 THINKING_LEVELS 的已知集合 + ultra 对齐）。 */
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

test("每个档位映射到各自的颜色变量（8 档 8 色，两两不同）", () => {
	const vars = EFFORTS.map((effort) => effortColorVar(effort));
	assert.equal(new Set(vars).size, EFFORTS.length, "档位色必须两两不同，否则视觉上分不出档位");
	assert.deepEqual(vars, ["var(--lv-off)", "var(--lv-minimal)", "var(--lv-low)", "var(--lv-medium)", "var(--lv-high)", "var(--lv-xhigh)", "var(--lv-max)", "var(--lv-ultra)"]);
});

test("未知档位回退到次要文字色，不返回 undefined", () => {
	const value = effortColorVar("future-level");
	assert.equal(value, "var(--color-text-secondary)");
	assert.ok(!value.includes("undefined"), "不得把 undefined 拼进 var()（颜色会整条失效）");
	assert.equal(hasEffortColor("future-level"), false);
});

test("空/未定义档位同样回退（不产生 var(undefined)）", () => {
	assert.equal(effortColorVar(undefined), "var(--color-text-secondary)");
	assert.equal(effortColorVar(""), "var(--color-text-secondary)");
	assert.equal(hasEffortColor(undefined), false);
});

test("已知档位 hasEffortColor 为 true（区别于兜底）", () => {
	for (const effort of EFFORTS) {
		assert.equal(hasEffortColor(effort), true, `${effort} 应有专属色`);
	}
});

test("foundation.css 为 8 个档位色提供明暗两套值", () => {
	// 浅色块（:root 主体）与暗色块（:root[data-theme="dark"]）都必须定义每个档位色，
	// 否则暗色主题下档位文字会继承亮色值、在深底上不可辨识。
	const darkStart = foundation.indexOf(':root[data-theme="dark"] {');
	assert.ok(darkStart > 0, "找不到暗色 token 块");
	const lightBlock = foundation.slice(0, darkStart);
	const darkBlock = foundation.slice(darkStart, foundation.indexOf(':root[data-theme="dark"][data-accent="green"]'));
	for (const effort of EFFORTS) {
		const pattern = new RegExp(`--lv-${effort}:\\s*#[0-9a-fA-F]{6}`);
		assert.match(lightBlock, pattern, `浅色缺少 --lv-${effort}`);
		assert.match(darkBlock, pattern, `暗色缺少 --lv-${effort}`);
	}
});

test("档位色刻意避开 success 绿（语义色不挪用）", () => {
	// 思考档位用绿色会与「成功」语义混淆；只允许 var(--color-success) 之外的字面色值。
	for (const effort of EFFORTS) {
		const match = foundation.match(new RegExp(`--lv-${effort}:\\s*([^;]+);`));
		assert.ok(match, `缺少 --lv-${effort}`);
		assert.doesNotMatch(match[1], /color-success/, `--lv-${effort} 不得引用 success 绿`);
	}
});
