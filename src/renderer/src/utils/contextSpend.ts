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
 * 已用百分比 → 圆环分档。
 *
 * 分档语义是「剩余」（contextRingLevel），而圆环弧长 / tooltip / 面板都是「已用」；
 * 本函数收口取反，避免各调用点各自写 `100 - percent` 造成两处口径分叉。
 */
export function contextRingLevelFromUsed(usedPercent: number): ContextRingLevel {
	if (!Number.isFinite(usedPercent)) return "normal";
	return contextRingLevel(100 - usedPercent);
}

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
 * 圆环分档 → 文字色（与环身同色系，但不含渐变：数字是纯色）。
 * normal 档沿用主文字色（常态不喧宾夺主），预警/危险档用对应状态色。
 */
export function contextRingTextColor(level: ContextRingLevel): string {
	switch (level) {
		case "notice":
		case "warn":
			return "var(--ctx-warn)";
		case "danger":
		case "critical":
			return "var(--ctx-danger)";
		default:
			return "var(--color-text-primary)";
	}
}
