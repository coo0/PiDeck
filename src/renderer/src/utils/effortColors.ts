/**
 * 思考档位 → 颜色变量映射（8 档 8 色）。
 *
 * 硬约束（`docs/composer-model-effort-context-dev.md` §3.3）：
 * - **刻意避开绿色**：`--color-success` 是「成功」语义色，用它表达思考档位会造成误读；
 * - **只作用于文字**：档位色用在 pill 的档位名上，滑块固定蓝色（`--color-info`）；
 * - 明暗两套色值定义在 `foundation.css` 的 token 区（`--lv-*`），这里只负责映射。
 */

/** 档位 id → CSS 变量名。新增档位时同时补 foundation.css 的明暗两套值。 */
const EFFORT_COLOR_VAR: Record<string, string> = {
	off: "--lv-off",
	minimal: "--lv-minimal",
	low: "--lv-low",
	medium: "--lv-medium",
	high: "--lv-high",
	xhigh: "--lv-xhigh",
	max: "--lv-max",
	ultra: "--lv-ultra",
};

/** 未知档位的兜底色（次要文字色），不得返回 undefined 导致颜色失效。 */
const EFFORT_FALLBACK_VAR = "--color-text-secondary";

/** 档位 → CSS 变量引用（`var(--lv-high)`）；未知档位回退到次要文字色。 */
export function effortColorVar(effort: string | undefined): string {
	if (!effort) return `var(${EFFORT_FALLBACK_VAR})`;
	return `var(${EFFORT_COLOR_VAR[effort] ?? EFFORT_FALLBACK_VAR})`;
}

/** 档位是否拥有专属色（未知/未来档位为 false，用兜底色）。 */
export function hasEffortColor(effort: string | undefined): boolean {
	return effort !== undefined && Object.hasOwn(EFFORT_COLOR_VAR, effort);
}
