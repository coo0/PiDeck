import { useCallback, useEffect, useRef, useState } from "react";
import { effortIndexFromPointer, effortIndexForKey, effortOffsetForIndex } from "../../utils/effortSlider";

/**
 * 思考档位滑块（一级浮层）。
 *
 * 几何与吸附全部来自 `utils/effortSlider`（纯函数，已单测）：本组件只负责
 * 指针/键盘事件、测量轨道宽度、把索引换算成圆钮与刻度点的位置。
 *
 * 两个已实测复现的坑（必须保留处理，删掉就会复发）：
 * 1. **`setPointerCapture` 要 try/catch**：无活动指针时会抛 `NotFoundError`
 *    （合成事件、极端时序），异常会打断后续 `apply()`，表现为「一次拖动直接失效」；
 * 2. **档位名固定宽度**在 pill 上（min-width: 46px）：否则拖动改档位 → pill 变宽 →
 *    浮层重量宽度 → 轨道在手指底下漂移（见 ModelEffortPopover 的注释）。
 *
 * 滑块颜色**固定蓝色**（`--color-info`），不随档位变色：档位信息只由 pill 里的
 * 文字颜色承担，轨道保持单一视觉语言，拖动时不会整条换色跳动。
 */
export function EffortSlider(props: {
	levels: readonly string[];
	current: string;
	disabled?: boolean;
	/** 拖动/键盘改变档位：每变一档都回调（实时跟随，不等到松手）。 */
	onChange: (effort: string) => void;
	/** 无障碍标签（i18n 文案，由调用方传入避免本组件依赖 i18n 上下文）。 */
	ariaLabel: string;
}) {
	const { levels, current, disabled, onChange, ariaLabel } = props;
	const railRef = useRef<HTMLDivElement | null>(null);
	const [railWidth, setRailWidth] = useState(0);
	const draggingRef = useRef(false);
	const [dragging, setDragging] = useState(false);
	const count = levels.length;
	const index = Math.max(0, levels.indexOf(current));
	// 回调与档位集合放 ref：事件处理器只注册一次，避免依赖变化反复退订/重订，
	// 也避免依赖数组里塞整个 props 对象（陈旧闭包 / 每帧重建监听）。
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const levelsRef = useRef(levels);
	levelsRef.current = levels;
	const currentRef = useRef(current);
	currentRef.current = current;
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;

	// 轨道宽度：首帧与窗口缩放都要重量（滑块是宽度自适应浮层的一部分）。
	useEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const measure = () => setRailWidth(rail.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(rail);
		return () => observer.disconnect();
	}, []);

	/** 指针 x → 最近档位（与圆钮渲染共用 effortSlider 的常量）。 */
	const applyPointer = useCallback((clientX: number) => {
		const rail = railRef.current;
		if (!rail) return;
		const rect = rail.getBoundingClientRect();
		const list = levelsRef.current;
		const next = effortIndexFromPointer({ clientX, railLeft: rect.left, railWidth: rect.width, count: list.length });
		const effort = list[next];
		if (effort !== undefined && effort !== currentRef.current) onChangeRef.current(effort);
	}, []);

	const endDrag = useCallback(() => {
		draggingRef.current = false;
		setDragging(false);
	}, []);

	// 拖动中在 window 上收尾：指针移出轨道（甚至移出窗口）后松手也必须结束拖动，
	// 否则 draggingRef 卡在 true，之后移动鼠标会莫名其妙改档位。
	useEffect(() => {
		if (!dragging) return;
		window.addEventListener("pointerup", endDrag);
		window.addEventListener("pointercancel", endDrag);
		return () => {
			window.removeEventListener("pointerup", endDrag);
			window.removeEventListener("pointercancel", endDrag);
		};
	}, [dragging, endDrag]);

	if (count === 0) return null;

	// 填充与圆钮共用同一 x（与吸附互为逆运算，见 effortSlider 单测）。
	const knobX = effortOffsetForIndex(index, railWidth, count);

	return (
		<div
			ref={railRef}
			role="slider"
			tabIndex={disabled ? -1 : 0}
			aria-label={ariaLabel}
			aria-valuemin={0}
			aria-valuemax={count - 1}
			aria-valuenow={index}
			aria-valuetext={current}
			aria-disabled={disabled}
			data-drag={dragging}
			className="relative mt-3 h-3.5 w-full min-w-[198px] cursor-ew-resize touch-none rounded-full bg-bg-active outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
			onPointerDown={(event) => {
				if (disabledRef.current) return;
				draggingRef.current = true;
				setDragging(true);
				// setPointerCapture 在无活动指针时会抛 NotFoundError（合成事件/极端时序），
				// 不能让异常打断后面的 apply——否则一次拖动直接失效。
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					// 捕获失败不影响拖动：window 上的收尾监听已兜住结束事件。
				}
				applyPointer(event.clientX);
				event.preventDefault();
			}}
			onPointerMove={(event) => {
				if (!draggingRef.current) return;
				applyPointer(event.clientX);
			}}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onKeyDown={(event) => {
				if (disabledRef.current) return;
				const next = effortIndexForKey(event.key, index, count);
				if (next === null) return;
				event.preventDefault();
				const effort = levels[next];
				if (effort !== undefined) onChangeRef.current(effort);
			}}
		>
			{/* 填充：固定蓝色渐变，不随档位变色（档位信息在 pill 的文字颜色上） */}
			<span
				aria-hidden="true"
				className="absolute top-0 bottom-0 left-0 rounded-full transition-[width] duration-[180ms] ease-out-quint"
				style={{
					width: `${knobX}px`,
					background: "linear-gradient(90deg, var(--color-info), color-mix(in srgb, var(--color-info) 78%, #fff 22%))",
				}}
			/>
			{/* 刻度点：已到达的档位为白色亮点，未到达的暗一些 */}
			{levels.map((level, dotIndex) => (
				<span
					key={level}
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
					style={{
						left: `${effortOffsetForIndex(dotIndex, railWidth, count)}px`,
						background: dotIndex <= index ? "rgba(255,255,255,.6)" : "var(--color-text-faint)",
						opacity: dotIndex <= index ? 1 : 0.65,
					}}
				/>
			))}
			{/* 圆钮：与吸附共用 KNOB_INSET，保证圆钮位置吸附回自身（单测锁定） */}
			<span
				aria-hidden="true"
				className="absolute top-1/2 z-2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white transition-[left,box-shadow] duration-[180ms] ease-out-quint"
				style={{
					left: `${knobX}px`,
					boxShadow: dragging ? "0 1px 6px rgba(0,0,0,.38), 0 0 0 4px color-mix(in srgb, var(--color-info) 26%, transparent)" : "0 1px 4px rgba(0,0,0,.3), 0 0 0 2px color-mix(in srgb, var(--color-info) 45%, transparent)",
				}}
			/>
		</div>
	);
}
