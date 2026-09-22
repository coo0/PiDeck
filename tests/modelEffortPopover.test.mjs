import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { nextView, isPopoverOpen } = loadTsCommonJs("src/renderer/src/utils/modelEffortPopover.ts");

/**
 * 两级浮层状态机：唯一正确行为表（docs/composer-model-effort-context-dev.md §1.2）。
 *
 * 两级共用一个浮层容器，视图切换只做宽度过渡；本文件逐条锁住转移表，
 * 避免 UI 侧把「选完模型」写成关闭（会多一次点击）。
 */

test("closed + open → effort（点 chip 进一级）", () => {
	assert.equal(nextView("closed", { kind: "open" }), "effort");
});

test("effort + toModels → models（点 pill 进二级）", () => {
	assert.equal(nextView("effort", { kind: "toModels" }), "models");
});

test("models + pickModel → effort（选完自动退回一级，不是关闭）", () => {
	// 关键决策：用户选完模型通常接着调档位，退回一级可少一次点击。
	assert.equal(nextView("models", { kind: "pickModel" }), "effort");
});

test("models + escape → effort（Esc 逐级返回）", () => {
	assert.equal(nextView("models", { kind: "escape" }), "effort");
});

test("effort + escape → closed", () => {
	assert.equal(nextView("effort", { kind: "escape" }), "closed");
});

test("任意状态 + outside → closed（外点一律关）", () => {
	assert.equal(nextView("effort", { kind: "outside" }), "closed");
	assert.equal(nextView("models", { kind: "outside" }), "closed");
	assert.equal(nextView("closed", { kind: "outside" }), "closed");
});

test("effort + open → effort（重复点击 chip 幂等，不叠加层级）", () => {
	assert.equal(nextView("effort", { kind: "open" }), "effort");
	// 已展开到二级时重复点 chip 也不该重置回一级（否则内容突然换掉）
	assert.equal(nextView("models", { kind: "open" }), "models");
});

test("closed + escape / outside → closed（幂等）", () => {
	assert.equal(nextView("closed", { kind: "escape" }), "closed");
	assert.equal(nextView("closed", { kind: "outside" }), "closed");
});

test("closed + toModels / pickModel → closed（未打开时不该进二级）", () => {
	assert.equal(nextView("closed", { kind: "toModels" }), "closed");
	assert.equal(nextView("closed", { kind: "pickModel" }), "closed");
});

test("effort + pickModel → effort（一级无模型可选，状态不变）", () => {
	assert.equal(nextView("effort", { kind: "pickModel" }), "effort");
});

test("chip + toggle：已打开时再点 chip 整个关闭（chip 是开关）", () => {
	// 原型：`$("chip").addEventListener("click", () => pop ? closePop() : openPop())`
	assert.equal(nextView("closed", { kind: "toggle" }), "effort");
	assert.equal(nextView("effort", { kind: "toggle" }), "closed");
	// 二级时点 chip 也是整个关闭（chip 是浮层总开关，不是「退回一级」）
	assert.equal(nextView("models", { kind: "toggle" }), "closed");
});

test("全事件矩阵穷举：任意 current × event 都返回合法视图", () => {
	const views = ["closed", "effort", "models"];
	const events = [{ kind: "open" }, { kind: "toggle" }, { kind: "toModels" }, { kind: "pickModel" }, { kind: "escape" }, { kind: "outside" }];
	for (const current of views) {
		for (const event of events) {
			const next = nextView(current, event);
			assert.ok(views.includes(next), `${current} + ${event.kind} 返回了非法视图 ${next}`);
		}
	}
});

test("isPopoverOpen 只在 closed 时为 false", () => {
	assert.equal(isPopoverOpen("closed"), false);
	assert.equal(isPopoverOpen("effort"), true);
	assert.equal(isPopoverOpen("models"), true);
});
