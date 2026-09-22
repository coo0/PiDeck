/**
 * 思考档位滑块的几何与吸附纯函数（底栏模型 chip 的一级浮层）。
 *
 * 吸附与渲染**必须共用同一组常量**：原型阶段曾出现「吸附用一个 inset、渲染用另一个」
 * 的偏差风险，已统一为 KNOB_INSET。分开写会让圆钮与命中位置错开半个档位。
 *
 * 设计依据：`docs/composer-model-effort-context-dev.md` §1.3（原型
 * `docs/prototypes/composer-model-effort-context.html` 的 indexFromPointer）。
 */

/**
 * 圆钮半径（px）：轨道两端各留出它，避免首尾档位的圆钮被轨道圆角裁掉。
 * 吸附与渲染共用此常量。
 */
export const KNOB_INSET = 9;

/**
 * 指针 x 坐标 → 最近档位索引（「最近中心点」算法）。
 *
 * 超出轨道两端时钳制到首尾档位，而不是不响应——用户拖出轨道仍应改档位，
 * 否则手感像「卡住了」。轨道尚未布局（railWidth = 0）或只有一个档位时返回 0，
 * 避免除零得到 NaN 让圆钮位置变成 `NaNpx`。
 */
export function effortIndexFromPointer(input: { clientX: number; railLeft: number; railWidth: number; count: number }): number {
	const { clientX, railLeft, railWidth, count } = input;
	if (count <= 1) return 0;
	// 首帧未布局（railWidth = 0）：返回首档而不是 NaN。除以被 max(1, …) 抬高后的
	// 可用宽度会把任意坐标都算成末档，所以必须先显式判掉。
	if (!Number.isFinite(railWidth) || railWidth <= 0) return 0;
	const usable = Math.max(1, railWidth - KNOB_INSET * 2);
	const t = Math.max(0, Math.min(1, (clientX - railLeft - KNOB_INSET) / usable));
	return Math.round(t * (count - 1));
}

/** 索引 → 档位 id（越界钳制；空集合返回 undefined，调用方据此不渲染滑块）。 */
export function effortFromIndex(levels: readonly string[], index: number): string | undefined {
	if (levels.length === 0) return undefined;
	return levels[Math.max(0, Math.min(levels.length - 1, index))];
}

/** 索引 → 圆钮/刻度点的 x 坐标（与 effortIndexFromPointer 共用 KNOB_INSET）。 */
export function effortOffsetForIndex(index: number, railWidth: number, count: number): number {
	if (count <= 1) return KNOB_INSET;
	const ratio = Math.max(0, Math.min(count - 1, index)) / (count - 1);
	return KNOB_INSET + ratio * Math.max(0, railWidth - KNOB_INSET * 2);
}

/** 键盘映射（与原型一致）：←/↓ 减一档、→/↑ 加一档、Home 首档、End 末档。 */
export function effortIndexForKey(key: string, currentIndex: number, count: number): number | null {
	if (count <= 0) return null;
	const last = count - 1;
	const clamp = (value: number) => Math.max(0, Math.min(last, value));
	switch (key) {
		case "ArrowLeft":
		case "ArrowDown":
			return clamp(currentIndex - 1);
		case "ArrowRight":
		case "ArrowUp":
			return clamp(currentIndex + 1);
		case "Home":
			return 0;
		case "End":
			return last;
		default:
			return null;
	}
}

/**
 * 模型切换后的档位兜底：当前档位不在新模型集合内时回落到 fallback。
 *
 * 优先级由调用方决定（模型默认档位 > 集合中间档 > 首档），这里只做「在集合内则保留」，
 * 避免把兜底策略复制到每个调用点。
 */
export function resolveEffortAfterModelChange(input: { current: string | undefined; levels: readonly string[]; fallback: string }): string {
	if (input.current !== undefined && input.levels.includes(input.current)) return input.current;
	if (input.levels.includes(input.fallback)) return input.fallback;
	return input.levels[0] ?? input.fallback;
}

/**
 * 兜底档位候选（按优先级）：模型默认档位 > 集合中间档 > 首档。
 * 与 resolveEffortAfterModelChange 配对：先算候选，再由它裁决。
 */
export function defaultEffortFallback(levels: readonly string[], preferred?: string): string {
	if (preferred !== undefined && levels.includes(preferred)) return preferred;
	const middle = levels[Math.floor((levels.length - 1) / 2)];
	return middle ?? "";
}
