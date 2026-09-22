/**
 * 模型 chip 浮层的两级状态机（纯函数，先写测试再动 UI）。
 *
 * 一级 = 档位（pill + 滑块），二级 = 选择模型列表。两级**共用一个浮层容器**，
 * 切换时只做宽度过渡（230↔452px），不出现「关一个开一个」的闪断。
 *
 * 关键决策：`pickModel → effort`（而不是 closed）——用户选完模型通常接着调档位
 * （两者强相关），退回一级可少一次点击。依据
 * `docs/composer-model-effort-context-dev.md` §1.2 的状态转移表。
 */

export type EffortPopoverView = "closed" | "effort" | "models";

export type EffortPopoverEvent =
	/** 点 chip 打开一级 */
	| { kind: "open" }
	/** 点 chip 切换：已打开则整个关闭（原型的 chip 是开关） */
	| { kind: "toggle" }
	/** 点一级里的 pill 进入二级 */
	| { kind: "toModels" }
	/** 在二级选中模型 */
	| { kind: "pickModel" }
	/** Esc：逐级返回 */
	| { kind: "escape" }
	/** 外点：一律关闭 */
	| { kind: "outside" };

/** 状态转移：唯一正确行为，逐条单测。 */
export function nextView(current: EffortPopoverView, event: EffortPopoverEvent): EffortPopoverView {
	// 外点一律关闭，不区分当前层级。
	if (event.kind === "outside") return "closed";
	// chip 是开关（原型 `pop ? closePop() : openPop()`）：已打开时再点整个关闭，
	// 二级也一并关（chip 是浮层总开关，不是「退回一级」）。
	if (event.kind === "toggle") return current === "closed" ? "effort" : "closed";
	if (event.kind === "escape") {
		// Esc 逐级返回：二级 → 一级 → 关闭。
		if (current === "models") return "effort";
		if (current === "effort") return "closed";
		return "closed";
	}
	if (event.kind === "open") {
		// 幂等：已打开时重复触发不叠加层级（也不重置到一级）。
		if (current === "closed") return "effort";
		return current;
	}
	if (event.kind === "toModels") {
		// 只有一级能进二级；closed 时不该发生（chip 未展开点不到 pill），保持 closed。
		return current === "effort" ? "models" : current;
	}
	// pickModel：选完自动退回一级（不是关闭），方便接着调档位。
	if (current === "models") return "effort";
	return current;
}

/** 浮层是否可见（渲染分支用，避免各处散写 `view !== "closed"`）。 */
export function isPopoverOpen(view: EffortPopoverView): boolean {
	return view !== "closed";
}
