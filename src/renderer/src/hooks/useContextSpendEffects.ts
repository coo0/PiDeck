import { useCallback, useEffect, useRef, useState } from "react";
import { consumeTokenDelta, formatSpendCount } from "../utils/contextSpend";
import { t } from "../i18n";

/**
 * 上下文消耗动画的队列与播放（`-N tok` 从圆环向左飞出）。
 *
 * 三条硬规则（`docs/composer-model-effort-context-dev.md` §2.2–§2.4）：
 * 1. **串行**：同时只飞一条，前一条结束后才播下一条（并行叠加会糊成一片）；
 * 2. **去重**：由 `consumeTokenDelta` 决定是否入队——重复读数、压缩回落、
 *    会话切换、首次读数都不触发（基线更新照旧，否则下一次差值会算错）；
 * 3. **纯数据层**：本 hook 不做任何「要不要显示」的判断——外观开关由组件层
 *    用 `hidden` 隐藏元素（display:none），与入队逻辑无关。
 *    早期版本在这里读 `prefers-reduced-motion` 提前 return，导致「开关打开也
 *    看不到动画」且用户无法自查；现已移除，改由 CSS 豁免（见 foundation.css）。
 *
 * 播放推进有 animationend 与 setTimeout 两条路径（双保险）：动画被中断/丢帧时
 * animationend 可能永远不来，超时兜底保证队列不会卡死。
 */

/** 扣血动画时长（与 tailwind.css 的 --animate-context-hit 一致；
 *  3000ms 对齐上游 codex-context-used-meter 的 SPEND_EFFECT_DURATION_MS）。 */
export const CONTEXT_SPEND_ANIMATION_MS = 3000;

/** 超时兜底余量：animationend 丢失时仍能推进队列。 */
const SPEND_FALLBACK_EXTRA_MS = 400;

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 当前是否处于「减少动效」偏好下（仅作调试/取证用，不参与入队判定）。 */
export function isReducedMotionPreferred(): boolean {
	return prefersReducedMotion();
}

export type ContextSpendEffects = {
	/** 当前正在播放的扣血标签（null = 无动画），由组件渲染成飞出元素。 */
	spendLabel: string | null;
	/** 每次开始播放自增：作为 key 重挂元素以重启动画，并驱动圆环 pulse。 */
	pulseKey: number;
	/** animationend 回调：提前结束本条并推进队列（与超时兜底二选一，先到先算）。 */
	onSpendAnimationEnd: () => void;
};

/**
 * 订阅 `contextTokens` 的相邻两帧差值，把「本次消耗」排成串行队列播放。
 *
 * @param input.sessionId 会话身份：变化即重置基线（不跨会话算差）。
 * @param input.tokens    当前累计上下文 tokens（runtime state.contextTokens）。
 * @param input.enabled   关闭时不入队（如生图模式没有 LLM 上下文）；基线照常更新。
 */
export function useContextSpendEffects(input: { sessionId: string; tokens?: number | null; enabled?: boolean }): ContextSpendEffects {
	const [spendLabel, setSpendLabel] = useState<string | null>(null);
	const [pulseKey, setPulseKey] = useState(0);
	/** 待播队列（标签文本） */
	const queueRef = useRef<string[]>([]);
	/** 当前播放中的标签；非 null 表示占位中，playNext 直接返回（串行的唯一判据） */
	const activeRef = useRef<string | null>(null);
	const timerRef = useRef<number | null>(null);
	/** 上一次读数（含归属会话）：差值计算的唯一基线 */
	const baselineRef = useRef<{ sessionId: string; tokens: number | null }>({
		sessionId: input.sessionId,
		tokens: input.tokens ?? null,
	});

	const clearTimer = useCallback(() => {
		if (timerRef.current === null) return;
		window.clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	/** 结束当前条目并推进队列（animationend 与超时兜底共用；重复调用安全）。 */
	const finishCurrent = useCallback(
		(label: string | null) => {
			// 迟到的回调不能结束「下一条」：只有仍在播的标签才算数。
			if (activeRef.current === null || (label !== null && activeRef.current !== label)) return;
			clearTimer();
			activeRef.current = null;
			setSpendLabel(null);
			const next = queueRef.current.shift();
			if (next === undefined) return;
			activeRef.current = next;
			setSpendLabel(next);
			setPulseKey((key) => key + 1);
			timerRef.current = window.setTimeout(() => finishCurrent(next), CONTEXT_SPEND_ANIMATION_MS + SPEND_FALLBACK_EXTRA_MS);
		},
		[clearTimer],
	);

	/** 取队首播放；已有在播条目时直接返回（串行）。 */
	const playNext = useCallback(() => {
		if (activeRef.current !== null) return;
		const next = queueRef.current.shift();
		if (next === undefined) return;
		activeRef.current = next;
		setSpendLabel(next);
		setPulseKey((key) => key + 1);
		timerRef.current = window.setTimeout(() => finishCurrent(next), CONTEXT_SPEND_ANIMATION_MS + SPEND_FALLBACK_EXTRA_MS);
	}, [finishCurrent]);

	const onSpendAnimationEnd = useCallback(() => {
		finishCurrent(activeRef.current);
	}, [finishCurrent]);

	useEffect(() => {
		const previous = baselineRef.current;
		const nextTokens = input.tokens ?? null;
		// 基线先行更新：即便本条不触发动画（回落/重复），下一次差值也必须基于新读数。
		baselineRef.current = { sessionId: input.sessionId, tokens: nextTokens };
		if (input.enabled === false) return;
		const delta = consumeTokenDelta({
			prevTokens: previous.tokens,
			nextTokens,
			prevSessionId: previous.sessionId,
			sessionId: input.sessionId,
		});
		if (delta === null) return;
		// 文案走 i18n（中英同 commit）：纯函数只格式化数字。
		queueRef.current.push(t("composerEffort.spendTokens", { tokens: formatSpendCount(delta) }));
		playNext();
	}, [input.sessionId, input.tokens, input.enabled, playNext]);

	// 卸载时清定时器与队列：切会话/关闭分屏不该留下孤儿 timer 或让队列跨会话续播。
	useEffect(() => {
		return () => {
			clearTimer();
			queueRef.current = [];
			activeRef.current = null;
		};
	}, [clearTimer]);

	return { spendLabel, pulseKey, onSpendAnimationEnd };
}
