import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Brain, Check, ChevronDown, ChevronLeft, CornerDownLeft, Eye, FileText, GitBranch, ImageIcon, ListChecks, Paperclip, Plus, RefreshCw, Sparkles, Target, Wrench, X } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { ConfirmDialog } from "../app/AppParts";
import { ComposerImageGenOptions } from "./ComposerImageGenOptions";
import { useComposerModeAvailability } from "../../hooks/useComposerModeAvailability";
import type { ImageGenConfigFile } from "../../../../shared/imageGenConfig";
import { SessionContextMeter } from "./SessionContextMeter";
import { ProviderUsageInline } from "../app/ProviderUsageInline";
import { useProviderUsageBatchRefresh } from "../../hooks/useProviderUsage";
import { DshLogo, PiLogo } from "./SessionSourceBadge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui-shadcn/select";
import { computeModelDisplay, formatModelRef, resolveComposerLiveModel, resolveGuideDisplayModel, type ModelPending } from "../../utils/modelPendingDisplay";
import { resolveComposerThinkingLevel } from "../../utils/thinkingDisplay";
import { WELCOME_MODEL_KEY, isWelcomeModelLost, readWelcomeModelPreference, readWelcomeThinkingPreference, shouldClearWelcomePreference } from "../../utils/chatSessionBootstrap";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import { CommandPickerGroup, CommandPickerPanel, type CommandPickerFilter } from "../ui-shadcn/command-picker";
import { THINKING_LEVELS, computeModelPickerDefaultExpanded, groupModelsByProvider, modelPickerSearchFilter, modelRowLabel, modelRowName, orderProviderGroups, resolveModelPickerBody } from "./sessionPickerOptions";
import { ModelPickerBody, currentModelKeyOf, modelPickerFilter, resolveModelPickerView, type ModelPickerSource } from "./ModelPickerBody";
import { ModelEffortPopover } from "./ModelEffortPopover";
import { effortColorVar } from "../../utils/effortColors";
import { isPopoverOpen, nextView, type EffortPopoverEvent, type EffortPopoverView } from "../../utils/modelEffortPopover";
import type { AgentBackend, AgentRuntimeState, AvailableModel, ComposerAgentMode, GitBranchInfo, ModelListFailReason, ModelListReport, SessionRecord, UsageProbeBackend } from "../../../../shared/types";

/** 单个 extension widget 卡片：可折叠标题栏 + 内容行，支持手动关闭 */
// widgetKey 由扩展定义且跨重启稳定,可按 widgetKey 持久化折叠状态。
const EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX = "pid:extension-widget-collapsed:";

/** 模式项标签文案（与旧 ComposerModeSelect 的 MODE_OPTIONS 同源）。 */
const MODE_LABEL: Record<ComposerAgentMode, TranslationKey> = {
	normal: "app.composerModeNormal",
	goal: "app.composerModeGoal",
	plan: "app.composerModePlan",
	imagegen: "app.composerModeImagegen",
};

/** 模式图标：普通=扳手，规划=清单，目标=靶心，生图=图片（与旧 chip 图标一致）。 */
function modeGlyph(mode: ComposerAgentMode) {
	if (mode === "plan") return <ListChecks size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "imagegen") return <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "goal") return <Target size={14} strokeWidth={2} aria-hidden="true" />;
	return <Wrench size={14} strokeWidth={2} aria-hidden="true" />;
}

/** 渲染 widget 单行内容，将 ✓/☑ 完成标记高亮为绿色，让 todo/plan 扩展的完成态更醒目。 */
export function renderWidgetLine(line: string): ReactNode {
	const parts = line.split(/(✓|☑)/g);
	if (parts.length <= 1) return line;
	return parts.map((part, i) =>
		part === "✓" || part === "☑" ? (
			<span key={i} className="widget-check-done">
				{part}
			</span>
		) : (
			part
		),
	);
}

/** 内置扩展 widget 的展示标题：widgetKey 是扩展内部标识（如 pi-deck-todo），直接展示不友好，映射为固定短名。 */
export function widgetDisplayTitle(widgetKey: string): string {
	if (widgetKey === "pi-deck-todo") return t("app.widgetTitleTodo");
	if (widgetKey === "pi-deck-plan-todos") return t("app.widgetTitlePlan");
	return widgetKey;
}

export function ExtensionWidgetCard(props: {
	widgetKey: string;
	lines: string[];
	onClose: () => void;
	/** 会话唯一标识，用于避免 Todo 等同名 widget 在不同 agent 间共享折叠状态。 */
	sessionIdOrPath?: string;
}) {
	const storageKey = props.sessionIdOrPath ? `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.sessionIdOrPath}:${props.widgetKey}` : `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.widgetKey}`;
	const [expanded, setExpanded] = useState(() => {
		if (typeof window === "undefined") return true;
		const stored = localStorage.getItem(storageKey);
		return stored !== null ? stored === "true" : true;
	});
	const prevStorageKeyRef = useRef(storageKey);

	// 切换 agent/session 时只读取对应 key，不把上一 agent 的状态写到新 key。
	useEffect(() => {
		if (prevStorageKeyRef.current === storageKey) return;
		prevStorageKeyRef.current = storageKey;
		const stored = localStorage.getItem(storageKey);
		setExpanded(stored !== null ? stored === "true" : true);
	}, [storageKey]);

	const handleToggleExpanded = useCallback(() => {
		setExpanded((prev) => {
			const next = !prev;
			localStorage.setItem(storageKey, String(next));
			return next;
		});
	}, [storageKey]);

	return (
		<div className="extension-widget-card">
			<div className="extension-widget-card-header">
				<button className="extension-widget-card-trigger" onClick={handleToggleExpanded} aria-expanded={expanded}>
					<ChevronDown size={14} className={`extension-widget-card-chevron${expanded ? " open" : ""}`} />
					<span className="extension-widget-card-title">{widgetDisplayTitle(props.widgetKey)}</span>
				</button>
				<button
					className="extension-widget-card-close"
					onClick={(e) => {
						e.stopPropagation();
						props.onClose();
					}}
					title={t("common.close")}
					aria-label={t("common.close")}
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>
			{expanded && (
				<div className="extension-widget-card-content">
					{props.lines.map((line, index) => (
						<div key={index} className="extension-widget-card-line">
							{renderWidgetLine(line)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** 输入框底栏的后端选择下拉（pi / dsh）：跟随会话后端（新建会话默认 pi，由设置项 defaultAgentBackend 决定）。
 * 触发区只显示当前后端 logo（不再带文字）；下拉选项保留文字便于选择时区分。 */
export function ComposerBackendPicker(props: { backend: AgentBackend; disabled?: boolean; onChangeBackend: (backend: AgentBackend) => void }) {
	return (
		<Select value={props.backend} disabled={props.disabled} onValueChange={(value) => props.onChangeBackend(value as AgentBackend)}>
			<SelectTrigger size="sm" className="composer-bar-btn backend h-7 gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 [&_[data-slot='select-icon']]:hidden" title={t("session.backendPickerHint")}>
				{/* 不渲染 SelectValue：按当前后端手动渲染 logo，输入框只显示图标不带文字。
				    隐藏 shadcn SelectTrigger 自带的 chevron（[data-slot='select-icon']），
				    否则 logo 与 chevron 并排（justify-between）→ 图标偏左不居中、
				    16px chevron 与 14px logo 混排导致上下不齐。 */}
				{props.backend === "dsh" ? <DshLogo className="size-[15px] shrink-0" /> : props.backend === "imagegen" ? <ImageIcon className="size-[15px] shrink-0 text-muted-foreground" /> : <PiLogo className="size-[15px] shrink-0" />}
			</SelectTrigger>
			<SelectContent align="start">
				<SelectItem value="pi">
					<PiLogo className="size-3.5 shrink-0" />
					{t("sessionSource.pi")}
				</SelectItem>
				<SelectItem value="dsh">
					<DshLogo className="size-3.5 shrink-0" />
					{t("sessionBackend.dsh")}
				</SelectItem>
				<SelectItem value="imagegen">
					<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
					{t("sessionBackend.imagegen")}
				</SelectItem>
			</SelectContent>
		</Select>
	);
}

/**
 * 底栏右侧分支切换器（shadcn 下拉）：当前分支 chip 即触发器，展开分支列表；
 * 选择目标分支后先弹确认（切换会携带未提交更改、冲突时 git 会拒绝），
 * 确认后才调 onSwitchBranch——owner 在 App 级（switchBranch 统一刷新
 * gitInfo/branchByProject），让右侧 Git 面板与底栏分支保持同步，不在此组件内
 * 再开一条 git 通道。无分支数据时回退为只读 span（由调用方兜底）。
 */
function ComposerBranchSwitcher(props: { gitInfo: GitBranchInfo; disabled?: boolean; onSwitchBranch: (branch: string) => void }) {
	const [pendingBranch, setPendingBranch] = useState<string | null>(null);
	return (
		<>
			{/* Radix DropdownMenu.Root 无 disabled 属性：禁用统一落在 trigger Button（已 disabled） */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn branch h-7 max-w-[12rem] gap-1 rounded-md px-1.5 text-sm font-semibold text-foreground/75 hover:bg-muted/60"
						title={t("app.branchCurrent", {
							branch: props.gitInfo.current,
							count: props.gitInfo.branches.length,
						})}
					>
						<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
						<span className="composer-bar-branch-name min-w-0 truncate">{props.gitInfo.current}</span>
						<ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-muted-foreground" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={4} className="min-w-56">
					{props.gitInfo.branches.map((branch) => {
						const current = branch === props.gitInfo.current;
						return (
							<DropdownMenuItem
								key={branch}
								// 当前分支不可再选（切换自身无意义）；选择后不立即切换，先走确认
								disabled={current}
								onSelect={() => setPendingBranch(branch)}
								className="min-h-8 gap-2 px-2.5 py-1"
							>
								<span className={`grid size-6 shrink-0 place-items-center rounded-md ${current ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
									<GitBranch size={13} strokeWidth={2} aria-hidden="true" />
								</span>
								<span className="min-w-0 flex-1 truncate font-mono text-caption text-foreground">{branch}</span>
								{current ? <Check size={14} strokeWidth={2} className="shrink-0 text-primary" aria-hidden="true" /> : null}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
			{pendingBranch && (
				<ConfirmDialog
					title={t("git.branchSwitcherConfirmTitle")}
					message={t("git.branchSwitcherConfirmMessage", { branch: pendingBranch })}
					confirmLabel={t("git.branchSwitcherConfirmLabel")}
					onConfirm={() => {
						props.onSwitchBranch(pendingBranch);
						setPendingBranch(null);
					}}
					onCancel={() => setPendingBranch(null)}
				/>
			)}
		</>
	);
}

export function ComposerBottomBar(props: {
	sessionId: string;
	state?: AgentRuntimeState;
	disabled?: boolean;
	/** thinking 按钮专用禁用：仅在 Agent 启动中禁用，运行中由后端决定是否接受修改。 */
	thinkingDisabled?: boolean;
	/** 分支切换专用禁用：agent 运行中保持锁定（切分支会真的改动工作区文件，
	 *  正在跑的代码被换掉有风险）；「+」菜单等草稿/下一轮配置类入口不跟随此锁。 */
	branchDisabled?: boolean;
	/** 模型按钮专用禁用：仅启动中禁用；运行中优先直接交给后端，busy 时才排到下一轮。 */
	modelDisabled?: boolean;
	/** 生成进行中已选定、本轮结束后才套到 Agent 的模型（显示为 from→to）。 */
	modelPending?: ModelPending;
	composerAgentMode: ComposerAgentMode;
	gitInfo?: GitBranchInfo;
	/** 切换分支（右侧分支下拉）：经栏级 usePaneGitInfo 的 switchBranch 执行，
	 *  成功后回写本栏 gitInfo 并通知 App（仅当本栏为聚焦项目时采纳），右侧 Git 面板与底栏保持同步。 */
	onSwitchBranch?: (branch: string) => void;
	/** Draft sessions do not have a runtime yet, so retain their persisted settings in the bar. */
	record?: Pick<SessionRecord, "model" | "thinkingLevel">;
	/** 当前绑定 runtime 仍 live（starting/idle/running）时，底栏才优先展示 state。 */
	runtimeLive?: boolean;
	/** DSH 部署默认模型/思考档位（settings.yaml agent-default-model）：草稿期展示默认值用，
	 *  不写入记录（激活后 runtime state 覆盖）。 */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	defaultThinkingLevel?: string;
	/** 当前会话后端（pi 缺省）。 */
	backend?: AgentBackend;
	/** 切换后端：UI 层面先停 runtime 再写 catalog。 */
	onChangeBackend?: (backend: AgentBackend) => void;
	feishuIndicator?: ReactNode;
	/** 安全等级选择器（自包含组件，注入到左下角工具组） */
	securityControl?: ReactNode;
	/** 快捷消息入口（自包含组件，摆在安全控制位右侧，符合「权限右边」的固定习惯） */
	quickMessagesControl?: ReactNode;
	voiceControls: ReactNode;
	sendControls: ReactNode;
	onPickModel: (model: AvailableModel) => void;
	onPickPromptTemplate: () => void;
	onPickSkill: () => void;
	onPickThinking: (effort: string) => void;
	/** 当前思考档位 id（浮层滑块用；与 thinkingText 同源）。 */
	currentEffort?: string;
	/** 可用档位（resolveThinkingPickerLevels 的唯一产物，与 Ctrl+T 的 Dialog 同源）。 */
	thinkingLevels?: Array<{ value: string; labelKey?: TranslationKey; label?: string }>;
	/** 二级视图的模型目录/偏好（与 Ctrl+M 的 Dialog 同一份数据源）。 */
	modelPickerSource?: ModelPickerSource & { onToggleFavorite?: (provider: string, modelId: string) => void; onToggleHideModel?: (provider: string, modelId: string) => void };
	/** 浮层开关状态上报（模型目录懒加载武装用）。 */
	onModelPopoverOpenChange?: (open: boolean) => void;
	onCompact: () => void;
	onChangeMode: (mode: ComposerAgentMode) => void;
	/** 会话已有生图消息时锁定生图模式，下拉不可切走。 */
	imageGenLocked?: boolean;
	onCancelPlan: () => void;
	onAttachFile: () => void;
	/** 生图模式底栏参数；非 imagegen 时不传。凭据来自独立 imagegen.json。 */
	imageGenOptions?: {
		config: ImageGenConfigFile;
		providerId: string;
		modelId: string;
		size: string;
		outputFormat: string;
		watermark: boolean;
		onSelectionChange: (providerId: string, modelId: string) => void;
		onSizeChange: (size: string) => void;
		onOutputFormatChange: (format: string) => void;
		onWatermarkChange: (watermark: boolean) => void;
	};
}) {
	// 真实会话以 runtime / catalog record 为准；只有无 record 的引导页虚拟会话
	// 才读取 welcome localStorage。这样用户点选模型/思考档位后能立即看到结果，
	// 首次发送再由 App.ensureSessionForSend 把同一显式选择带入真实会话。
	// 该偏好可能指向已删除的模型（localStorage 残留，用户删除模型后底栏仍显示旧默认）：
	// 引导页（无 record、pi 后端）常驻加载模型目录做存在性校验（与 ComposerPickerHost
	// 同一判定 isWelcomeModelLost），失效则忽略偏好并清理缓存，显示回落到主进程解析的
	// 启动默认 defaultModel（launchDefaults 已校验 models.json 存在性）。
	// 目录命中主进程全局缓存（模型选择器同源），通常不会额外 fork pi。
	const isDsh = props.backend === "dsh";
	const needsWelcomeCatalog = !props.record && !isDsh;
	const { models: welcomeCatalogModels, report: welcomeCatalogReport } = useBackendModelCatalog({
		sessionId: props.sessionId,
		backend: isDsh ? "dsh" : "pi",
		enabled: needsWelcomeCatalog,
	});
	const welcomeModel = needsWelcomeCatalog ? readWelcomeModelPreference()?.model : undefined;
	// 思考档位不依赖模型目录；无 record 时直接读取 picker 写入的显式选择。
	const welcomeThinking = !props.record ? readWelcomeThinkingPreference()?.thinkingLevel : undefined;
	const welcomeModelLost = isWelcomeModelLost(welcomeModel, welcomeCatalogModels);
	// 删除不可逆，走保守判定：只有「一次成功的完整加载」才具备判死资格。
	// 本组件不传 projectId → 目录恒为全局范围，与全局偏好的作用域一致。
	const clearWelcomePreference = shouldClearWelcomePreference({
		welcomeModel,
		models: welcomeCatalogModels,
		catalogLoaded: welcomeCatalogReport?.ok === true,
		catalogIsGlobal: true,
	});
	useEffect(() => {
		// 失效偏好只清一次：下次引导页不再默认已删除的模型（创建时主进程也会兜底丢弃）。
		if (clearWelcomePreference) {
			try {
				localStorage.removeItem(WELCOME_MODEL_KEY);
			} catch {
				// localStorage 不可用时静默；展示层已忽略该偏好。
			}
		}
	}, [clearWelcomePreference]);
	const effectiveWelcomeModel = welcomeModelLost ? undefined : welcomeModel;
	// 引导页（无 record、pi）默认模型展示：与主进程创建解析同序（点选 > 显式默认 > 切换列表 > 上次使用）。
	// 规则收拢到 resolveGuideDisplayModel，与 ComposerPickerHost 共用一份，避免两侧各自演化。
	const guideDefaultModel = resolveGuideDisplayModel({
		isDsh,
		welcomeModel: effectiveWelcomeModel,
		defaultModel: props.defaultModel,
	});
	const runtimeLive = Boolean(props.runtimeLive);
	// 用量查询链路随会话后端：DSH 会话走 dsh（$DSH_HOME 配置 + 凭据库），其余走 pi。
	// 圆球面板必须与 DSH 卡片/选择器同一 backend，否则查的是另一条 usage-probes.json。
	const usageBackend: UsageProbeBackend = isDsh ? "dsh" : "pi";
	// DSH 草稿：记录未填默认时用部署默认（settings.yaml agent-default-model）兜底展示。
	// 非 live runtime 的残留 state 不能盖住 catalog：Agent 未启动时改模型/思考档位要立刻反映在底栏。
	const currentThinkingLevel = resolveComposerThinkingLevel({
		state: props.state?.thinkingLevel,
		record: props.record?.thinkingLevel,
		// 引导页显式点选优先；未选择时才回退主进程解析的配置默认档位。
		fallback: welcomeThinking ?? props.defaultThinkingLevel,
		isLive: runtimeLive,
	});
	const thinkingLevelLabel = (level: string) => {
		const labelKey = THINKING_LEVELS.find((item) => item.value === level)?.labelKey;
		return labelKey ? t(labelKey) : level;
	};
	const thinkingText = currentThinkingLevel ? thinkingLevelLabel(currentThinkingLevel) : t("app.think");
	const isPlanMode = props.composerAgentMode === "plan";
	const isImageGenMode = props.composerAgentMode === "imagegen";
	const isGoalMode = props.composerAgentMode === "goal";
	const isSpecialMode = isPlanMode || isImageGenMode || isGoalMode;
	// 模式选择收进「+」菜单后，底栏不再常驻模式 chip；可用性（plan/goal 扩展开关、
	// imagegen 仅 pi、imageGenLocked 锁定）由专用 hook 统一维护（原 ComposerModeSelect 逻辑）。
	const { visibleModes, refreshAvailability } = useComposerModeAvailability({
		backend: props.backend,
		imageGenLocked: props.imageGenLocked,
		value: props.composerAgentMode,
		disabled: props.disabled,
		onChange: props.onChangeMode,
	});
	const liveModel = resolveComposerLiveModel({
		state: props.state,
		record: props.record?.model,
		fallback: guideDefaultModel,
		isLive: runtimeLive,
	});
	const modelDisplay = computeModelDisplay(liveModel.modelId ? liveModel : undefined, props.modelPending);
	const modelFrom = modelDisplay.from;
	const modelTo = modelDisplay.to;
	const modelProvider = modelFrom?.provider;
	const modelName = modelFrom?.modelName || modelFrom?.modelId;
	const modelLabel = modelName ? formatModelRef(modelFrom ?? { provider: "", modelId: "" }) : `${t("app.model")}: -`;
	const modelPendingTitle = props.modelPending
		? t("app.modelPendingTitle", {
				from: formatModelRef(props.modelPending.from),
				to: formatModelRef(props.modelPending.to),
			})
		: undefined;
	// 底栏只承载当前状态和直接操作，快捷键说明留给设置页，避免再次挤压编辑器。
	// shrink-0：面板缩到最小时底栏不被输入区挤扁/挤出滚动条
	return (
		<div className="composer-bottom-bar min-h-10 shrink-0 border-t border-transparent px-2.5 py-2">
			<div className="composer-bottom-layout flex min-w-0 items-center gap-2">
				<div className="composer-bottom-left flex min-w-0 flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
					{props.onChangeBackend ? (
						<ComposerBackendPicker backend={props.backend ?? "pi"} disabled={props.disabled} onChangeBackend={props.onChangeBackend} />
					) : props.backend ? (
						/* 后端已锁定（会话激活后不可切换：pi 文件与 DSH session log 格式不同，
						   中途切换会导致消息同步渲染不可靠）：只读标识，只显示官方 logo 不重复文字。
						   inline-flex 居中：span 默认 inline，svg 按 baseline 排会偏上，
						   与底栏其它按钮（flex 居中 15px 图标）水平不平齐。
						   用户输入时 Agent 可能已被自动启动、后端随之锁定，但用户不一定知情；
						   点击时弹提示说明锁定原因与换后端的途径（新建会话）。 */
						<button
							type="button"
							className="composer-bar-btn backend inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-control font-semibold text-foreground hover:bg-muted/60"
							title={t("session.backendLockedHint")}
							aria-label={t("session.backendLockedHint")}
							onClick={() => showNotice(t("session.backendLockedNotice"), 5000)}
						>
							{props.backend === "dsh" ? <DshLogo className="size-[15px] shrink-0" /> : props.backend === "imagegen" ? <ImageIcon className="size-[15px] shrink-0 text-muted-foreground" /> : <PiLogo className="size-[15px] shrink-0" />}
						</button>
					) : null}
					{/* 特殊模式退出×：模式选择已收进「+」菜单，底栏只保留进行中模式的退出入口
					    （imagegen 同样可退出；imageGenLocked 时无法切走故不显示）。 */}
					{isSpecialMode && !props.imageGenLocked && (
						<div className="composer-mode-cluster inline-flex h-7 min-w-0 items-center rounded-md bg-bg-hover pr-0.5">
							<button
								type="button"
								className="composer-mode-exit mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-text-tertiary transition-[color,background-color] duration-150 hover:bg-bg-active hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
								aria-label={isGoalMode ? t("app.composerModeCancelGoal") : isImageGenMode ? t("app.composerModeCancelImagegen") : t("app.composerModeCancelPlan")}
								title={isGoalMode ? t("app.composerModeCancelGoal") : isImageGenMode ? t("app.composerModeCancelImagegen") : t("app.composerModeCancelPlan")}
								disabled={props.disabled}
								onClick={props.onCancelPlan}
							>
								<X size={12} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
					)}
					{/* 三合一「+」入口：附件/技能/提示词/模式 收起为单个菜单，底栏更简洁；
					    菜单项 onSelect 后 Radix 自动关闭；打开时刷新模式可用性（扩展开关可能刚改过）。 */}
					<DropdownMenu
						onOpenChange={(open) => {
							if (open) void refreshAvailability();
						}}
					>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60" aria-label={t("app.composerAddTitle")} title={t("app.composerAddTitle")} disabled={props.disabled}>
								<Plus size={15} strokeWidth={2} aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
							{/* 生图模式用图片粘贴添加参考图，不需要文件选择器上传附件 */}
							{!isImageGenMode && (
								<DropdownMenuItem onSelect={() => props.onAttachFile()}>
									<Paperclip size={14} strokeWidth={2} aria-hidden="true" />
									{t("app.composerAddAttach")}
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onSelect={() => props.onPickSkill()}>
								<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
								{t("app.composerAddSkill")}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onPickPromptTemplate()}>
								<FileText size={14} strokeWidth={2} aria-hidden="true" />
								{t("app.composerAddPrompt")}
							</DropdownMenuItem>
							{/* 模式分组：普通/目标/规划/生图收进「+」，底栏只留进行中模式的退出×。
							   用 DropdownMenuLabel 分组（附件/技能/提示词与模式不是同一维度）。 */}
							<DropdownMenuLabel className="mt-1 text-micro font-medium text-muted-foreground">{t("app.composerAddMode")}</DropdownMenuLabel>
							{visibleModes.map((mode) => (
								<DropdownMenuItem key={mode} disabled={props.disabled} onSelect={() => props.onChangeMode(mode)}>
									{modeGlyph(mode)}
									{t(MODE_LABEL[mode])}
									{mode === props.composerAgentMode && <Check size={14} strokeWidth={2} className="ml-auto text-primary" aria-hidden="true" />}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					{props.feishuIndicator}
					{/* 生图模式无 pi/DSH runtime：安全等级（pi 安全门）与 DSH 权限预设都对图片生成无意义，
					   且 SecurityControl 按 backend 分发时没有 imagegen 分支会误显示成 pi 安全等级菜单；
					   快捷消息同理（正文是给对话模型的指令），两个控制位一起屏蔽。 */}
					{isImageGenMode ? null : (
						<>
							{props.securityControl}
							{props.quickMessagesControl}
						</>
					)}
				</div>
				<div className={`composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4${isImageGenMode ? " overflow-x-auto overflow-y-hidden [scrollbar-width:none]" : " overflow-hidden"}`}>
					{isImageGenMode && props.imageGenOptions ? (
						<ComposerImageGenOptions
							config={props.imageGenOptions.config}
							providerId={props.imageGenOptions.providerId}
							modelId={props.imageGenOptions.modelId}
							size={props.imageGenOptions.size}
							outputFormat={props.imageGenOptions.outputFormat}
							watermark={props.imageGenOptions.watermark}
							disabled={props.disabled}
							onSelectionChange={props.imageGenOptions.onSelectionChange}
							onSizeChange={props.imageGenOptions.onSizeChange}
							onOutputFormatChange={props.imageGenOptions.onOutputFormatChange}
							onWatermarkChange={props.imageGenOptions.onWatermarkChange}
						/>
					) : null}
					{/* 生图模式用独立供应商/模型下拉，不展示会话 LLM chip，避免两套配置混用。 */}
					{isImageGenMode ? null : (
						<ModelThinkingChip
							modelLabel={modelLabel}
							modelPendingTo={modelDisplay.pending && modelTo ? modelTo.modelName || modelTo.modelId : undefined}
							modelPendingTitle={modelPendingTitle}
							thinkingText={thinkingText}
							currentEffort={props.currentEffort}
							thinkingLevels={props.thinkingLevels ?? THINKING_LEVELS}
							pickerSource={props.modelPickerSource ?? { models: [] }}
							disabled={props.modelDisabled ?? props.disabled}
							thinkingDisabled={props.thinkingDisabled}
							onPickModel={props.onPickModel}
							onPickThinking={props.onPickThinking}
							onPopoverOpenChange={props.onModelPopoverOpenChange}
						/>
					)}
					{/* DSH 压缩入口与 pi 统一：上下文圆环（右侧）常驻并带压缩按钮。
					    2026-12 兼容期：dsh runtime state 已由主进程提供 contextPercent 兜底
					    （request/context 的 contextWindow + 消息估算），圆环不再因缺数据隐藏，
					    原独立 compact 按钮移除，避免双入口。 */}
				</div>
				<div className="composer-bottom-right ml-auto flex shrink-0 items-center gap-2">
					{/* 上下文占用圆环（dsh ContextMeter 移植）：发送按钮旁常驻指示,
					    点击展开占用面板（两段占比/缓存命中/输入输出/压缩入口）；
					    压缩动作从右上角紧凑徽章迁入面板；无 capacity 数据时自身不渲染。
					    生图模式没有 LLM 上下文（消息不进 pi/DSH 会话，历史独立存 ImageSessionStore），
					    圆环与压缩入口一并屏蔽。 */}
					{isImageGenMode ? null : (
						<SessionContextMeter
							sessionId={props.sessionId}
							state={props.state}
							onCompact={props.onCompact}
							backend={usageBackend}
							// 未激活会话用会话记录/默认 model 推导的 provider 查用量（用量不依赖 agent 运行）
							fallbackProvider={modelProvider}
						/>
					)}
					{/* 分支只读 chip 升级为可切换下拉：当前分支即触发器，展开列表选目标分支后
					    先弹确认（切换会携带未提交更改），确认后才调栏级 switchBranch（绑定本栏项目）。 */}
					{props.gitInfo?.current && props.onSwitchBranch ? (
						<ComposerBranchSwitcher gitInfo={props.gitInfo} disabled={props.branchDisabled ?? props.disabled} onSwitchBranch={props.onSwitchBranch} />
					) : props.gitInfo?.current ? (
						<span
							className="composer-bar-branch inline-flex max-w-[12rem] items-center gap-1.5 truncate px-1.5 text-sm font-semibold text-foreground/75"
							title={t("app.branchCurrent", {
								branch: props.gitInfo.current,
								count: props.gitInfo.branches.length,
							})}
						>
							<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
							<span className="composer-bar-branch-name truncate">{props.gitInfo.current}</span>
						</span>
					) : null}
					{props.voiceControls}
					{props.sendControls}
				</div>
			</div>
		</div>
	);
}

/**
 * 模型 + 思考合并选择 chip（借鉴 dsh ModelSelect 的 trigger 形态）。
 *
 * 显示：`模型名 · 思考档位 + chevron` 一体。
 * 交互：点击弹出 root 菜单两行（模型 / 思考），drill-in 复用现有 Dialog 选择器
 * （onPickModel / onPickThinking），列表 UI 不重做。
 */
/**
 * 模型 + 思考合并选择 chip（借鉴 dsh ModelSelect 的 trigger 形态）。
 *
 * 显示：`模型名 · 思考档位 + chevron` 一体（保持原样）。
 * 交互：点 chip 弹**一级浮层**（档位 pill + 蓝色滑块，改档位零弹窗）；点 pill 进
 * **二级浮层**（选择模型列表，复用 Ctrl+M 的 ModelPickerBody）。两级共用一个容器，
 * 宽度 230↔452px 过渡；选中模型后退回一级，Esc 逐级返回，外点关闭。
 *
 * 定位宿主：外层 wrapper 是 `position: relative`，浮层与 chip 同级——挂到应用容器
 * 会让 `left: 0` 把浮层甩到最左边（原型实测）。
 */
function ModelThinkingChip(props: {
	modelLabel: string;
	/** 模型待生效切换的目标 label（存在时显示 from → to） */
	modelPendingTo?: string;
	modelPendingTitle?: string;
	thinkingText: string;
	/** 当前思考档位 id（滑块用；与 chip 的 thinkingText 同源）。 */
	currentEffort?: string;
	/** 可用档位（resolveThinkingPickerLevels 的唯一产物）。 */
	thinkingLevels: Array<{ value: string; labelKey?: TranslationKey; label?: string }>;
	disabled?: boolean;
	thinkingDisabled?: boolean;
	/** 模型目录/偏好（二级视图用；与 Ctrl+M 的 Dialog 同一份数据源）。 */
	pickerSource: ModelPickerSource & { onToggleFavorite?: (provider: string, modelId: string) => void; onToggleHideModel?: (provider: string, modelId: string) => void };
	onPickModel: (model: AvailableModel) => void;
	onPickThinking: (effort: string) => void;
	/** 浮层开关状态上报：二级视图需要模型目录，用它武装目录懒加载。 */
	onPopoverOpenChange?: (open: boolean) => void;
}) {
	// 两级状态机：唯一正确行为见 utils/modelEffortPopover（已单测）。
	const [view, setView] = useState<EffortPopoverView>("closed");
	const hostRef = useRef<HTMLSpanElement | null>(null);
	const onPopoverOpenChangeRef = useRef(props.onPopoverOpenChange);
	onPopoverOpenChangeRef.current = props.onPopoverOpenChange;
	const dispatch = useCallback((event: EffortPopoverEvent) => {
		setView((current) => {
			const next = nextView(current, event);
			if (next !== current) onPopoverOpenChangeRef.current?.(next !== "closed");
			return next;
		});
	}, []);
	const modelValue = props.modelPendingTo ? `${props.modelLabel} → ${props.modelPendingTo}` : props.modelLabel;
	// 档位名与 chip 同源（i18n labelKey → label → 原样 id）。
	const effortText = props.thinkingText;

	return (
		<span ref={hostRef} className="relative inline-flex">
			<Button
				variant="ghost"
				size="sm"
				className="composer-bar-btn model-thinking flex h-7 min-w-0 max-w-[52ch] gap-1 rounded-md px-2 text-caption font-medium text-foreground hover:bg-muted/60"
				title={props.modelPendingTitle ?? t("app.modelPickerTitle")}
				aria-expanded={isPopoverOpen(view)}
				onClick={() => dispatch({ kind: "toggle" })}
			>
				<span className="min-w-0 truncate">{modelValue}</span>
				<span className="flex-none text-muted-foreground/70" aria-hidden="true">
					·
				</span>
				<span className="flex-none truncate" style={{ color: effortColorVar(props.currentEffort) }} title={t("app.thinkingPickerTitle")}>
					{effortText}
				</span>
				<ChevronDown size={12} aria-hidden="true" className={`flex-none text-muted-foreground transition-transform duration-150${isPopoverOpen(view) ? " rotate-180" : ""}`} />
			</Button>
			{/* 浮层与 chip 同级（同一个 relative 宿主内）：定位以 chip 为锚点居中。 */}
			<ModelEffortPopover
				view={view}
				onViewEvent={dispatch}
				onClose={() => dispatch({ kind: "outside" })}
				modelLabel={props.modelLabel}
				modelPendingTo={props.modelPendingTo}
				currentEffort={props.currentEffort}
				levels={props.thinkingLevels}
				onPickEffort={props.onPickThinking}
				onPickModel={props.onPickModel}
				effortDisabled={props.thinkingDisabled}
				anchorRef={hostRef}
				{...props.pickerSource}
			/>
		</span>
	);
}

/**
 * 选择器对话框外壳（#115 U5 收尾）：统一 shadcn Dialog + cmdk Command，
 * 旧 Prompt 选择器仍使用统一 shadcn Dialog + cmdk；模型、思考级别和引导页使用 CommandPickerPanel，共享折叠、搜索和选中项定位。
 * 保留此壳是为了支持 Prompt 预览态的特殊头部与返回操作。
 */
export function PickerDialog(props: { title: string; hint?: string; onClose: () => void; className?: string; children: ReactNode }) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]", props.className)}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<div className="grid gap-0.5">
						<DialogTitle>{props.title}</DialogTitle>
						{props.hint && <small className="text-muted-foreground text-caption">{props.hint}</small>}
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				{props.children}
			</DialogContent>
		</Dialog>
	);
}

/** Dialog wrapper for the shared Command panel; the panel owns header, search, groups, and footer. */
function CommandPickerDialog(props: {
	title: string;
	hint?: string;
	onClose: () => void;
	className?: string;
	searchPlaceholder?: string;
	emptyLabel?: ReactNode;
	value?: string;
	showGroupActions?: boolean;
	/** 默认展开的分组 id 集合（null = 默认全展开）；透传给 CommandPickerPanel。 */
	defaultExpandedIds?: ReadonlySet<string> | null;
	/** 搜索过滤函数；缺省用 cmdk 内置 fuzzy（仅模型选择器等长列表需要传精确子串过滤）。 */
	filter?: CommandPickerFilter;
	/** 标题栏操作（如模型列表手动刷新按钮）；渲染在折叠/展开按钮之后、关闭按钮之前 */
	headerAction?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]", props.className)}>
				<CommandPickerPanel
					title={props.title}
					hint={props.hint}
					searchPlaceholder={props.searchPlaceholder ?? t("app.commandPickerSearch")}
					emptyLabel={props.emptyLabel ?? t("app.commandPickerEmpty")}
					value={props.value}
					showGroupActions={props.showGroupActions}
					defaultExpandedIds={props.defaultExpandedIds}
					filter={props.filter}
					headerAction={props.headerAction}
					onClose={props.onClose}
				>
					{props.children}
				</CommandPickerPanel>
			</DialogContent>
		</Dialog>
	);
}

export function ModelPicker(
	props: ModelPickerSource & {
		onClose: () => void;
		onPick: (model: AvailableModel) => void;
		onToggleFavorite?: (provider: string, modelId: string) => void;
		onToggleHideModel?: (provider: string, modelId: string) => void;
	},
) {
	// 列表主体与底栏二级浮层共用 ModelPickerBody：收藏星/隐藏眼/选中勾/用量 trailing
	// 只有一处实现；本组件只提供 Dialog 外壳（标题栏 + 搜索 + 折叠动作）。
	const view = resolveModelPickerView(props);
	return (
		<CommandPickerDialog
			title={t("app.modelPickerTitle")}
			onClose={props.onClose}
			className="model-picker sm:max-w-[min(720px,calc(100vw-32px))]"
			searchPlaceholder={t("app.modelPickerSearch")}
			emptyLabel={t("app.modelPickerEmpty")}
			value={currentModelKeyOf(props)}
			showGroupActions
			defaultExpandedIds={view.defaultExpandedIds}
			// 精确子串搜索：cmdk 默认 fuzzy 会让 1-2 字符词命中全部 tokendance 模型（见
			// modelPickerSearchFilter 注释）；其他选择器（思考级别/预设）仍用默认 fuzzy。
			filter={modelPickerFilter}
			// 手动刷新入口：标题栏右上角，任何情况下（含加载失败）都能重新拉取模型列表。
			headerAction={
				props.onRefresh ? (
					<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={t("app.modelPickerRefresh")} title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")} onClick={props.onRefresh} disabled={props.refreshing}>
						<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
					</Button>
				) : undefined
			}
		>
			<ModelPickerBody {...props} view={view} />
		</CommandPickerDialog>
	);
}

export function ThinkingPicker(props: {
	current?: string;
	onClose: () => void;
	onPick: (level: string) => void;
	/** 受支持的档位列表（DSH 按当前模型 reasoningEfforts 过滤）；缺省用全部档位。 */
	levels?: Array<{
		value: string;
		labelKey?: TranslationKey;
		descriptionKey?: TranslationKey;
		label?: string;
		description?: string;
	}>;
}) {
	const levels = props.levels ?? THINKING_LEVELS;
	return (
		<CommandPickerDialog title={t("app.thinkingPickerTitle")} hint={t("app.thinkingPickerHint")} onClose={props.onClose} className="thinking-picker" value={props.current}>
			{levels.length === 0 ? (
				// 空数组只代表后端明确返回「当前模型没有可用档位」。目录未加载或模型
				// 未声明元数据时宿主会传 undefined，继续展示全量兼容档位而不是阻断用户。
				<div className="flex min-h-24 items-center justify-center px-4 text-center text-caption text-muted-foreground">{t("app.thinkingPickerUnsupported")}</div>
			) : (
				levels.map((level) => {
					const selected = level.value === props.current;
					return (
						<CommandItem key={level.value} value={level.value} data-picker-value={level.value} onSelect={() => props.onPick(level.value)} className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1">
							<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
								<Brain size={14} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground" title={level.descriptionKey ? t(level.descriptionKey) : level.description}>
								{level.labelKey ? t(level.labelKey) : (level.label ?? level.value)}
							</span>
							{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
						</CommandItem>
					);
				})
			)}
		</CommandPickerDialog>
	);
}

/**
 * Prompt Template 选择器：列出 ~/.pi/agent/prompts/ 下所有 .md 模板，
 * 点击后将模板内容插入到 composer 输入框。
 */
export function PromptTemplatePicker(props: {
	templates: Array<{
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}>;
	onClose: () => void;
	onPick: (template: { name: string; path: string; description: string; content: string; scope?: "global" | "project"; argumentHint?: string }) => void;
	/** 一键插入模板全文到输入框（可选：ComposerPickerHost 传 controller 方法）。 */
	onInsertContent?: (template: { name: string; path: string; description: string; content: string; scope?: "global" | "project"; argumentHint?: string }) => void;
}) {
	type TemplateItem = (typeof props.templates)[number];
	const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);

	// 预览态：替换标题为返回按钮 + 模板名，正文为模板内容（沿用旧内联预览设计）
	if (previewTemplate) {
		return (
			<PickerDialog title={t("app.promptTemplatePreviewTitle", { name: "/" + previewTemplate.name })} onClose={props.onClose} className="prompt-template-picker">
				<div className="picker-preview-inline">
					<div className="flex items-center justify-between gap-2">
						<Button type="button" variant="ghost" className="h-auto gap-1 px-1 text-caption" onClick={() => setPreviewTemplate(null)} title={t("app.promptTemplateBackToPicker")}>
							<ChevronLeft size={16} strokeWidth={2.2} />
							{t("app.promptTemplateBackToPicker")}
						</Button>
						{/* 预览里同样可以一键插入全文（与条目上的插入按钮入口并列） */}
						{props.onInsertContent && (
							<Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={() => props.onInsertContent?.(previewTemplate)} title={t("app.pickerInsertContent")}>
								<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
								{t("app.pickerInsertContent")}
							</Button>
						)}
					</div>
					<pre className="picker-preview-content">{previewTemplate.content}</pre>
				</div>
			</PickerDialog>
		);
	}

	return (
		/* 与技能/模型选择器对齐（#115 之后的双行卡片式条目）：
		   首行图标 + 斜杠命令名 + 参数提示徽标，次行截断的描述；
		   预览按钮保留（查看模板正文）。旧 picker-palette-* 单行挤排版弃用。 */
		<PickerDialog title={t("app.promptTemplatePickerTitle")} hint={t("app.pickerInsertSendHint")} onClose={props.onClose} className="prompt-template-picker">
			<Command>
				<CommandInput placeholder={t("app.promptTemplateSearchPlaceholder")} autoFocus />
				<CommandList className="max-h-[min(420px,55vh)]">
					<CommandEmpty>{t("app.promptTemplateSearchEmpty")}</CommandEmpty>
					{props.templates.length === 0 && <div className="px-6 py-10 text-center text-caption text-muted-foreground">{t("app.promptTemplateEmpty")}</div>}
					{props.templates.map((template) => (
						<CommandItem key={template.path} value={`/${template.name}`} keywords={[template.name, template.description, template.argumentHint ?? ""]} onSelect={() => props.onPick(template)} className="group min-h-10 items-center gap-2.5 rounded-md px-3 py-2">
							<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground">
								<FileText size={14} strokeWidth={1.8} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex items-center gap-1.5">
									<span className="font-mono text-control font-semibold text-foreground" title={`/${template.name}`}>
										/{template.name}
									</span>
									{template.argumentHint && <code className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">{template.argumentHint}</code>}
								</span>
								{template.description && (
									<span className="mt-0.5 block truncate text-caption text-muted-foreground" title={template.description}>
										{template.description}
									</span>
								)}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title={t("common.preview")}
								onClick={(e) => {
									e.stopPropagation();
									setPreviewTemplate(template);
								}}
							>
								<Eye size={14} strokeWidth={1.8} aria-hidden="true" />
							</Button>
							{/* 一键插入全文：把模板内容整段塞进输入框（不生成斜线命令），
							    与 onPick（插入 /名称 命令）是并列入口，两者由用户视需要选择。 */}
							{props.onInsertContent && (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									title={t("app.pickerInsertContent")}
									onClick={(e) => {
										e.stopPropagation();
										props.onInsertContent?.(template);
									}}
								>
									<CornerDownLeft size={14} strokeWidth={1.8} aria-hidden="true" />
								</Button>
							)}
						</CommandItem>
					))}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}
