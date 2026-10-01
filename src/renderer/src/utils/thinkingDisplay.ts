/**
 * Derive the thinking-level text from PiDeck's saved selection.
 * Runtime telemetry remains available elsewhere, but cannot replace the user preference shown
 * in the composer or picker.
 */
export type PendingThinkingSelection = { from?: string; to?: string };

export type ThinkingDisplayResult = {
	levels: string[];
	pending: boolean;
};

export function computeThinkingDisplay(current: string | undefined, pending?: PendingThinkingSelection): ThinkingDisplayResult {
	if (pending) return { levels: [...new Set([pending.from, pending.to].filter((level): level is string => Boolean(level)))], pending: true };
	return {
		levels: current ? [current] : [],
		pending: false,
	};
}

/**
 * 底栏/选择器当前思考档位只读取会话保存的用户选择或引导页默认。
 * runtime 回传值描述执行状态，不能改写 PiDeck 的当前选择。
 */
export function resolveComposerThinkingLevel(input: { record?: string; fallback?: string; pending?: PendingThinkingSelection }): string | undefined {
	return input.pending?.to ?? input.record ?? input.fallback;
}
