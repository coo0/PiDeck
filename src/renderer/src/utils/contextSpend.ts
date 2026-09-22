/**
 * 上下文消耗检测（纯函数 + 去重）与圆环状态分档。
 *
 * 背景：`contextTokens` 是**累计值**，相邻两帧的差才是「本次消耗」。直接对读数做动画
 * 会在四种情况下误报，全部必须显式排除（`docs/composer-model-effort-context-dev.md` §2.3）：
 * 首次读数（无基线）、重复上报（轮询/重放）、压缩后回落（差为负）、会话切换（跨会话算差）。
 */

/**
 * 扣血数字的千分位格式化（`1,240`）。
 *
 * 只格式化**数字**，`-{tokens} tok` 的外壳交给 i18n（`composerEffort.spendTokens`），
 * 避免把用户可见文案硬编码在纯函数里。
 */
export function formatSpendCount(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

/**
 * 由相邻两次 contextTokens 读数算出「本次消耗」；返回 null 表示不应触发动画。
 *
 * 返回差值（正数）而不是标签，让调用方自己决定展示形态（标签、累计、埋点），
 * 纯函数只负责「该不该触发、触发多少」。
 */
export function consumeTokenDelta(input: { prevTokens?: number | null; nextTokens?: number | null; prevSessionId?: string; sessionId: string }): number | null {
	const { prevTokens, nextTokens, prevSessionId, sessionId } = input;
	// 会话切换：基线属于另一个会话，差值没有意义（切回来时也不该补飞一条）。
	if (prevSessionId !== undefined && prevSessionId !== sessionId) return null;
	if (nextTokens == null || !Number.isFinite(nextTokens)) return null;
	if (prevTokens == null || !Number.isFinite(prevTokens)) return null;
	// 相同读数（重复上报）与压缩后回落（差为负）都不触发，仅由调用方更新基线。
	if (nextTokens <= prevTokens) return null;
	return nextTokens - prevTokens;
}

export type ContextRingLevel = "normal" | "notice" | "warn" | "danger" | "critical";

/**
 * 剩余占用 → 圆环状态（阈值与 dev 文档 §2.1 表一致）。
 *
 * 语义是「剩余百分比」（left），不是已用：剩余越低越危险。
 * 非有限值按 normal 处理（无数据时圆环走占位态，不误报危险）。
 */
export function contextRingLevel(leftPercent: number): ContextRingLevel {
	if (!Number.isFinite(leftPercent)) return "normal";
	if (leftPercent <= 30) return "critical";
	if (leftPercent <= 40) return "danger";
	if (leftPercent <= 50) return "warn";
	if (leftPercent <= 60) return "notice";
	return "normal";
}

/**
 * 已用百分比 → 剩余百分比。
 *
 * 原型里圆环的弧长、数字、tooltip 都以**剩余**为准（`state.left = 78.4`
 * → `--ring-angle: 282deg`），而 runtime 上报的是**已用**（`contextPercent`）。
 * 本函数是两者之间的唯一换算点，避免各处散写 `100 - percent`。
 */
export function contextLeftPercent(usedPercent: number): number {
	if (!Number.isFinite(usedPercent)) return 100;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

/**
 * 剩余百分比 → conic-gradient 角度（从 12 点方向顺时针）。
 * 原型：`--ring-angle = left * 3.6`（78.4 → 282deg）。
 * **画的是剩余**：消耗时环变短，与 tooltip 的「剩余」口径一致。
 */
export function contextRingAngleDeg(leftPercent: number): number {
	if (!Number.isFinite(leftPercent)) return 0;
	return Math.max(0, Math.min(100, leftPercent)) * 3.6;
}

/** 压缩预警阈值（剩余百分比）：跌破它时圆环外圈浮出斜线弧。 */
export const CONTEXT_WARN_LEFT_PERCENT = 20;

/** 是否展示压缩预警弧（剩余 ≤ 20%）。 */
export function showContextWarnArc(leftPercent: number): boolean {
	return Number.isFinite(leftPercent) && leftPercent <= CONTEXT_WARN_LEFT_PERCENT;
}

/** 预警弧的起始角度（原型 `--zone-start: 72deg` = 20 * 3.6）。 */
export const CONTEXT_WARN_ZONE_START_DEG = CONTEXT_WARN_LEFT_PERCENT * 3.6;

/**
 * 圆环双色（起点 → 终点）的 CSS 变量引用：颜色即状态。
 *
 * 映射与 dev 文档 §2.1 表一致：normal 蓝→紫 / notice·warn 黄→橙 /
 * danger·critical 橙→红。返回 `var(--ctx-*)` 引用而不是字面色值，
 * 让明暗两套由 foundation.css 的 token 承担（不新建调色板）。
 */
export function contextRingColorVars(level: ContextRingLevel): { a: string; b: string } {
	switch (level) {
		case "notice":
		case "warn":
			return { a: "var(--ctx-warn)", b: "var(--ctx-warn2)" };
		case "danger":
		case "critical":
			return { a: "var(--ctx-warn2)", b: "var(--ctx-danger)" };
		default:
			return { a: "var(--ctx-ok)", b: "var(--ctx-ok2)" };
	}
}

/**
 * 分档 → 容器 `data-level` 值（驱动边框与数字色的 CSS 选择器）。
 *
 * 为什么保留这个恒等映射：分档公式在 TS，而边框/数字色的具体样式在
 * `foundation.css`（明暗两套 + color-mix），两边靠 `data-level` 这个契约对齐。
 * 收成一个导出值是让「哪几档存在」只有一处定义，新增档位不会漏改 CSS。
 */
export function contextLevelAttribute(level: ContextRingLevel): string {
	return level;
}
