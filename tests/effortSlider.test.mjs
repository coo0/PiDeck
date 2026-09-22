import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { KNOB_INSET, effortIndexFromPointer, effortFromIndex, effortOffsetForIndex, effortIndexForKey, resolveEffortAfterModelChange, defaultEffortFallback } = loadTsCommonJs("src/renderer/src/utils/effortSlider.ts");

/** 轨道几何：left=100、width=200、6 档 → 可用区间 [109, 291]，档间距 36.4。 */
const RAIL = { railLeft: 100, railWidth: 200, count: 6 };

test("指针落在档位中心时吸附到该档位", () => {
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 100 + KNOB_INSET }), 0);
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 300 - KNOB_INSET }), 5);
	// 可用区间中点 = 109 + 182/2 = 200 → 2.5 档，四舍五入到 3（0.5 向上）
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 200 }), 3);
});

test("吸附用最近中心点：偏向哪一侧就取哪一档", () => {
	// 档位 2 中心 = 109 + 2*36.4 = 181.8；档位 3 中心 = 218.2
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 181.8 }), 2);
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 218.2 }), 3);
	// 略微偏向档位 2 一侧仍取 2，越过中点才跳到 3
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 195 }), 2);
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 205 }), 3);
});

test("指针在轨道两端之外时钳制到首尾档位", () => {
	// 左端之外：不返回负数
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: -500 }), 0);
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 100 }), 0);
	// 右端之外：不超过 count-1
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 9999 }), 5);
	assert.equal(effortIndexFromPointer({ ...RAIL, clientX: 300 }), 5);
});

test("单档位不除零：count=1 恒返回 0", () => {
	assert.equal(effortIndexFromPointer({ railLeft: 100, railWidth: 200, count: 1, clientX: 9999 }), 0);
	assert.equal(effortIndexFromPointer({ railLeft: 0, railWidth: 0, count: 1, clientX: 0 }), 0);
});

test("轨道宽度为 0（首帧未布局）返回 0 而不是 NaN", () => {
	const index = effortIndexFromPointer({ railLeft: 0, railWidth: 0, count: 6, clientX: 120 });
	assert.equal(index, 0);
	assert.ok(Number.isFinite(index), "不得返回 NaN（会让圆钮位置变成 NaNpx）");
});

test("档位索引与 id 双向映射，越界钳制", () => {
	const levels = ["off", "low", "medium", "high", "xhigh", "max"];
	assert.equal(effortFromIndex(levels, 0), "off");
	assert.equal(effortFromIndex(levels, 5), "max");
	assert.equal(effortFromIndex(levels, -3), "off");
	assert.equal(effortFromIndex(levels, 99), "max");
	// 空集合返回 undefined：调用方据此不渲染滑块
	assert.equal(effortFromIndex([], 0), undefined);
});

test("渲染位置与吸附共用 KNOB_INSET（首尾圆钮不被轨道圆角裁切）", () => {
	// 首档 = inset，末档 = width - inset：两端各留一个圆钮半径
	assert.equal(effortOffsetForIndex(0, 200, 6), KNOB_INSET);
	assert.equal(effortOffsetForIndex(5, 200, 6), 200 - KNOB_INSET);
	// 单档位落在 inset 处，不除零
	assert.equal(effortOffsetForIndex(0, 200, 1), KNOB_INSET);
	assert.ok(Number.isFinite(effortOffsetForIndex(0, 0, 6)));
});

test("吸附与渲染互为逆运算（同一 clientX 不会渲染到别的档位）", () => {
	const levels = ["off", "low", "medium", "high", "xhigh", "max"];
	for (let index = 0; index < levels.length; index++) {
		const x = effortOffsetForIndex(index, RAIL.railWidth, RAIL.count) + RAIL.railLeft;
		assert.equal(effortIndexFromPointer({ ...RAIL, clientX: x }), index, `档位 ${index} 的圆钮位置应吸附回自身`);
	}
});

test("键盘映射：方向键加减一档，Home/End 到两端", () => {
	assert.equal(effortIndexForKey("ArrowLeft", 3, 6), 2);
	assert.equal(effortIndexForKey("ArrowDown", 3, 6), 2);
	assert.equal(effortIndexForKey("ArrowRight", 3, 6), 4);
	assert.equal(effortIndexForKey("ArrowUp", 3, 6), 4);
	assert.equal(effortIndexForKey("Home", 4, 6), 0);
	assert.equal(effortIndexForKey("End", 1, 6), 5);
	// 其他键不处理
	assert.equal(effortIndexForKey("Enter", 3, 6), null);
	assert.equal(effortIndexForKey("a", 3, 6), null);
	// 空集合不处理
	assert.equal(effortIndexForKey("ArrowRight", 0, 0), null);
});

test("键盘在两端不越界（长按不飞出档位集合）", () => {
	assert.equal(effortIndexForKey("ArrowLeft", 0, 6), 0);
	assert.equal(effortIndexForKey("ArrowRight", 5, 6), 5);
});

test("模型切换后：当前档位仍受支持则保留", () => {
	assert.equal(
		resolveEffortAfterModelChange({
			current: "high",
			levels: ["low", "medium", "high", "max"],
			fallback: "medium",
		}),
		"high",
	);
});

test("模型切换后：当前档位不受支持则回落到 fallback", () => {
	// off 不在新模型集合内（如从 deepseek 换到 claude）
	assert.equal(
		resolveEffortAfterModelChange({
			current: "off",
			levels: ["low", "medium", "high", "max"],
			fallback: "medium",
		}),
		"medium",
	);
});

test("模型切换后：fallback 也不在集合内时回落到首档（不产生空档位）", () => {
	assert.equal(
		resolveEffortAfterModelChange({
			current: "ultra",
			levels: ["low", "medium"],
			fallback: "xhigh",
		}),
		"low",
	);
	// 当前档位为 undefined（草稿期无档位）时同样走兜底
	assert.equal(
		resolveEffortAfterModelChange({
			current: undefined,
			levels: ["low", "medium"],
			fallback: "xhigh",
		}),
		"low",
	);
});

test("兜底候选优先级：模型默认档位 > 集合中间档 > 首档", () => {
	// 模型声明了默认档位且受支持：用它
	assert.equal(defaultEffortFallback(["low", "medium", "high"], "high"), "high");
	// 模型默认档位不受支持：退回中间档（6 档 → 索引 2）
	assert.equal(defaultEffortFallback(["off", "low", "medium", "high", "xhigh", "max"], "ultra"), "medium");
	// 无默认档位：中间档
	assert.equal(defaultEffortFallback(["low", "medium", "high"]), "medium");
	// 空集合：空串（调用方不渲染滑块）
	assert.equal(defaultEffortFallback([]), "");
});
