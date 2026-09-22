import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { AvailableModel } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { CommandPickerPanel } from "../ui-shadcn/command-picker";
import { EffortSlider } from "./EffortSlider";
import { ModelPickerBody, currentModelKeyOf, modelPickerFilter, resolveModelPickerView, type ModelPickerSource } from "./ModelPickerBody";
import { effortColorVar } from "../../utils/effortColors";
import { defaultEffortFallback, resolveEffortAfterModelChange } from "../../utils/effortSlider";
import { isPopoverOpen, type EffortPopoverView } from "../../utils/modelEffortPopover";

/**
 * 模型 chip 的两级浮层（一级：档位 pill + 滑块；二级：选择模型列表）。
 *
 * 设计要点（`docs/composer-model-effort-context-dev.md` §1.4–§1.6，原型为唯一真相）：
 * - **两级共用一个容器**，切换时只做宽度过渡（一级随内容钳制 230–430px，二级固定 452px），
 *   不出现「关一个开一个」的闪断；
 * - 定位以 chip 为锚点水平居中，并在应用边界内钳制（左右各 8px）；向上弹出，
 *   顶部空间不足时翻转到下方；
 * - 选中模型后**退回一级**（不是关闭）：用户选完模型通常接着调档位；
 * - Esc 逐级返回，外点一律关闭（转移表见 utils/modelEffortPopover，已单测）。
 *
 * 两个已实测复现的坑（必须保留处理，删掉就会复发）：
 * 1. **档位名固定宽度**（pill 的档位名 min-width: 46px）：档位名长度不一
 *    （off / high / xhigh / medium），若随文字变宽，拖动改档位 → pill 变宽 →
 *    浮层重量宽度 → **轨道在手指底下被重新定位**。配套：宽度只在**模型变化**时重算
 *    （见下面量宽元素与 effect 依赖），档位变化不重量。
 * 2. **宽度不用 offsetWidth 当过渡目标**：宽度过渡期间 offsetWidth 读到的是中间值，
 *    用它算 left 会让浮层在动画中左右抖动。这里改为量一个**自身宽度不受过渡影响**的
 *    内容盒（w-max），量出的值稳定，再写回 px 驱动过渡。
 */

/** 二级视图固定宽度（原型 452px）。 */
const MODELS_WIDTH = 452;
/** 一级视图宽度钳制（短模型名窄、长模型名宽）。 */
const EFFORT_MIN_WIDTH = 230;
const EFFORT_MAX_WIDTH = 430;
/** 一级内容盒的最小宽度：滑块 min-width 198 + 左右内边距 16*2 = 230。 */
const EFFORT_CONTENT_MIN_WIDTH = 198;
/** 与 chip 的间距 / 与应用边界的留白。 */
const ANCHOR_GAP = 9;
const EDGE_GAP = 8;

export type ModelEffortPopoverProps = ModelPickerSource & {
	/** 视图状态机（由调用方持有，chip 的 chevron 旋转与它同步）。 */
	view: EffortPopoverView;
	/** 状态机事件（toModels / pickModel / escape / outside；open 由 chip 触发）。 */
	onViewEvent: (event: { kind: "toModels" } | { kind: "pickModel" } | { kind: "escape" } | { kind: "outside" }) => void;
	/** 关闭回调（状态机落到 closed）。 */
	onClose: () => void;
	/** 一级视图里显示的模型名（含厂商前缀），与 chip 同源。 */
	modelLabel: string;
	/** 模型待生效切换的目标 label（存在时显示 from → to）。 */
	modelPendingTo?: string;
	/** 当前思考档位与可用档位（唯一来源：resolveThinkingPickerLevels）。 */
	currentEffort?: string;
	levels: Array<{ value: string; labelKey?: TranslationKey; label?: string }>;
	/** 档位变更（实时，每变一档都回调）。 */
	onPickEffort: (effort: string) => void;
	/** 模型选中（复用现有 applyModel 链路）。 */
	onPickModel: (model: AvailableModel) => void;
	/** 收藏 / 隐藏（二级视图内直接操作，与 Ctrl+M 的 Dialog 同一份 settings 写入）。 */
	onToggleFavorite?: (provider: string, modelId: string) => void;
	onToggleHideModel?: (provider: string, modelId: string) => void;
	/** 一级视图的禁用位（启动中锁定）。 */
	effortDisabled?: boolean;
	/** 定位宿主（position: relative 的 wrapper）：浮层按它居中，而不是贴应用左边。 */
	anchorRef: React.RefObject<HTMLElement | null>;
};

/** 档位显示名：优先 i18n 的 labelKey，其次 label，最后原样 id（与 chip 同规则）。 */
function effortLabel(level: { value: string; labelKey?: TranslationKey; label?: string } | undefined): string {
	if (!level) return "";
	if (level.labelKey) return t(level.labelKey);
	return level.label ?? level.value;
}

/** 一级视图：pill（进二级）+ 蓝色滑块（改档位）。 */
function EffortView(props: {
	/** 内容盒 ref：宽度由它量出（w-max，不受浮层宽度过渡影响）。 */
	contentRef: React.RefObject<HTMLDivElement | null>;
	modelLabel: string;
	modelPendingTo?: string;
	effort: string;
	effortText: string;
	levels: readonly string[];
	disabled?: boolean;
	onToModels: () => void;
	onPickEffort: (effort: string) => void;
}) {
	return (
		<div ref={props.contentRef} className="flex w-max min-w-[198px] flex-col px-4 pt-3.5 pb-4">
			<button
				type="button"
				className="flex h-[26px] min-w-0 items-center justify-center gap-1.5 rounded-full bg-bg-active px-2.5 text-control transition-colors duration-150 hover:bg-bg-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-bg-active"
				title={t("composerEffort.modelsTitle")}
				disabled={props.disabled}
				onClick={props.onToModels}
			>
				<span className="min-w-0 truncate font-mono font-semibold text-foreground">{props.modelPendingTo ? `${props.modelLabel} → ${props.modelPendingTo}` : props.modelLabel}</span>
				{/* ★ min-width: 46px：档位名长度不一，宽度固定才不会在拖动时把浮层顶宽、轨道漂移 */}
				<span className="min-w-[46px] flex-none text-center font-mono font-medium" style={{ color: effortColorVar(props.effort) }}>
					{props.effortText}
				</span>
				<ChevronRight size={12} strokeWidth={2.6} aria-hidden="true" className="flex-none text-text-faint" />
			</button>
			<EffortSlider levels={props.levels} current={props.effort} disabled={props.disabled} onChange={props.onPickEffort} ariaLabel={t("composerEffort.effortLabel")} />
		</div>
	);
}

/**
 * 二级视图：标题栏（展开/折叠/刷新/关闭）+ 搜索 + 列表主体。
 * 列表主体复用 ModelPickerBody（与 Ctrl+M 的 Dialog 同一份实现），
 * 本组件只提供浮层专用的紧凑外壳（dense 度量）。
 */
function ModelsView(
	props: ModelPickerSource & {
		onClose: () => void;
		onPick: (model: AvailableModel) => void;
		onToggleFavorite?: (provider: string, modelId: string) => void;
		onToggleHideModel?: (provider: string, modelId: string) => void;
		/** 选中模型后上报（状态机据此退回一级）。 */
		onPicked: () => void;
	},
) {
	const view = resolveModelPickerView(props);
	return (
		<CommandPickerPanel
			title={t("composerEffort.modelsTitle")}
			searchPlaceholder={t("composerEffort.searchPlaceholder")}
			emptyLabel={t("app.modelPickerEmpty")}
			value={currentModelKeyOf(props)}
			showGroupActions
			defaultExpandedIds={view.defaultExpandedIds}
			filter={modelPickerFilter}
			onClose={props.onClose}
			className="max-h-[min(500px,60vh)] bg-transparent"
			headerAction={
				props.onRefresh ? (
					<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={t("app.modelPickerRefresh")} title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")} onClick={props.onRefresh} disabled={props.refreshing}>
						<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
					</Button>
				) : undefined
			}
		>
			<ModelPickerBody
				models={props.models}
				current={props.current}
				report={props.report}
				loading={props.loading}
				refreshing={props.refreshing}
				onRefresh={props.onRefresh}
				backend={props.backend}
				favoriteModels={props.favoriteModels}
				recentProviders={props.recentProviders}
				providerOrder={props.providerOrder}
				hiddenProviders={props.hiddenProviders}
				hiddenModels={props.hiddenModels}
				onToggleFavorite={props.onToggleFavorite}
				onToggleHideModel={props.onToggleHideModel}
				view={view}
				dense
				onPick={(model) => {
					props.onPick(model);
					// 选中后退回一级（不是关闭）——由状态机落地，这里只上报。
					props.onPicked();
				}}
			/>
		</CommandPickerPanel>
	);
}

/**
 * 浮层本体：定位 + 宽度过渡 + 两级视图切换。
 *
 * 必须渲染在 chip 宿主的**同级**（同一个 position: relative 容器内），这样 left
 * 相对宿主计算、浮层才会落在模型名上方；挂到应用容器会跑到最左边。
 */
export function ModelEffortPopover(props: ModelEffortPopoverProps) {
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(EFFORT_MIN_WIDTH);
	const [left, setLeft] = useState(0);
	const [flipDown, setFlipDown] = useState(false);
	const open = isPopoverOpen(props.view);
	const isModelsView = props.view === "models";
	// 宽度只跟模型走：档位变化不改浮层宽度（pill 档位名已固定 46px）。
	// 依赖里放 modelKey 而不是 currentEffort，就是为了让「拖动改档位」不触发重量。
	const modelKey = `${props.current?.provider ?? ""}/${props.current?.modelId ?? ""}`;

	const level = props.levels.find((item) => item.value === props.currentEffort);
	const effortText = effortLabel(level) || props.currentEffort || "";
	// §1.8 模型切换后的档位兜底（仅展示层）：当前档位不在新模型的档位集合内时
	// （如从 deepseek 换到不支持 off 的 claude），滑块不能用 indexOf=-1 把圆钮钉在首档
	// 而 pill 仍显示旧档位。这里回落到集合内的有效档位。
	//
	// 刻意**不**额外发一条 setRuntimeThinking：后端换模型时已经按目标模型的
	// defaultEffort 重新选档（DSH 的 selectModelWithCatalogEffort 明确不沿用旧档位），
	// 前端再发一条会与它竞争、反而可能把正确值盖掉。
	const levelValues = props.levels.map((item) => item.value);
	const displayEffort = levelValues.length === 0 ? (props.currentEffort ?? "") : resolveEffortAfterModelChange({ current: props.currentEffort, levels: levelValues, fallback: defaultEffortFallback(levelValues) });
	const displayLevel = props.levels.find((item) => item.value === displayEffort);
	const displayEffortText = effortLabel(displayLevel) || displayEffort;

	/**
	 * 定位与宽度：按 chip 居中，再在应用边界内钳制。
	 *
	 * 一级宽度量自内容盒（w-max，自身宽度不受浮层 width 过渡影响），因此量到的
	 * 是稳定值；再写回 px 驱动过渡（不写具体 px 则 CSS 无法在两级间做动画）。
	 */
	const place = useCallback(() => {
		const popover = popoverRef.current;
		const anchor = props.anchorRef.current;
		if (!popover || !anchor) return;
		const anchorRect = anchor.getBoundingClientRect();
		let nextWidth = MODELS_WIDTH;
		if (!isModelsView) {
			const content = contentRef.current;
			// 内容盒缺失（首帧）时退回最小值，不阻塞定位。
			const measured = content ? Math.max(content.offsetWidth, EFFORT_CONTENT_MIN_WIDTH + 32) : EFFORT_MIN_WIDTH;
			nextWidth = Math.min(EFFORT_MAX_WIDTH, Math.max(EFFORT_MIN_WIDTH, measured));
		}
		// 边界：以视口为界钳制（左右各留 EDGE_GAP）。
		// 不用「应用容器」而用视口：视口钳制是严格更安全的约束（浮层永不越出屏幕），
		// 且无需为取应用根节点再穿一层 ref（composer 横跨窗口，两者结果一致）。
		const centered = anchorRect.width / 2 - nextWidth / 2;
		const min = EDGE_GAP - anchorRect.left;
		const max = window.innerWidth - EDGE_GAP - nextWidth - anchorRect.left;
		// 先钳到 [min, max]，再与 centered 取交集——窗口比浮层还窄（min > max）时
		// 保证不越出左侧，而不是算出越界值。
		setLeft(Math.round(Math.max(min, Math.min(max, centered))));
		setWidth(nextWidth);
		// 翻转：上方空间不足时改到 chip 下方（与 SessionContextMeter 面板同策略）。
		setFlipDown(anchorRect.top - ANCHOR_GAP - (popover.offsetHeight || 0) < EDGE_GAP);
	}, [isModelsView, props.anchorRef]);

	// 打开 / 切视图 / 换模型后重新定位与量宽。effect 依赖里的 modelKey 就是
	// 「宽度只在模型变化时重算」的守卫（拖动改档位不会进这里）。
	useLayoutEffect(() => {
		if (!open) return;
		place();
	}, [open, props.view, modelKey, place]);

	// 窗口尺寸变化（含分屏拖拽）后重新定位；不关闭浮层。
	useEffect(() => {
		if (!open) return;
		let raf = 0;
		const reanchor = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("resize", reanchor);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", reanchor);
		};
	}, [open, place]);

	const { onViewEvent, anchorRef } = props;
	// Esc 逐级返回；外点在 document 捕获阶段关闭（浮层内 / chip 内不关）。
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			onViewEvent({ kind: "escape" });
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (popoverRef.current?.contains(target)) return;
			// chip 自身由宿主处理（点 chip 是切换开关，不能既关又开）。
			if (anchorRef.current?.contains(target)) return;
			onViewEvent({ kind: "outside" });
		};
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [open, onViewEvent, anchorRef]);

	if (!open) return null;

	return (
		<div
			ref={popoverRef}
			data-view={props.view}
			data-testid="model-effort-popover"
			className="absolute z-60 overflow-hidden rounded-xl border border-border-default bg-popover text-foreground shadow-[var(--shadow-popover)] transition-[width,left] duration-[220ms] ease-out-quint"
			style={{
				width: `${width}px`,
				left: `${left}px`,
				...(flipDown ? { top: `calc(100% + ${ANCHOR_GAP}px)` } : { bottom: `calc(100% + ${ANCHOR_GAP}px)` }),
			}}
		>
			{/* 隐形桥接：鼠标从 chip 移到浮层途中不闪断 */}
			<span aria-hidden="true" className="absolute right-0 -bottom-[11px] left-0 h-[11px]" />
			{isModelsView ? (
				<ModelsView
					models={props.models}
					current={props.current}
					report={props.report}
					loading={props.loading}
					refreshing={props.refreshing}
					onRefresh={props.onRefresh}
					backend={props.backend}
					favoriteModels={props.favoriteModels}
					recentProviders={props.recentProviders}
					providerOrder={props.providerOrder}
					hiddenProviders={props.hiddenProviders}
					hiddenModels={props.hiddenModels}
					onClose={props.onClose}
					onPick={props.onPickModel}
					onToggleFavorite={props.onToggleFavorite}
					onToggleHideModel={props.onToggleHideModel}
					onPicked={() => props.onViewEvent({ kind: "pickModel" })}
				/>
			) : (
				<EffortView contentRef={contentRef} modelLabel={props.modelLabel} modelPendingTo={props.modelPendingTo} effort={displayEffort} effortText={displayEffortText} levels={levelValues} disabled={props.effortDisabled} onToModels={() => props.onViewEvent({ kind: "toModels" })} onPickEffort={props.onPickEffort} />
			)}
		</div>
	);
}
