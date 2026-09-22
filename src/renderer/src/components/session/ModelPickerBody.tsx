import { useEffect } from "react";
import { Check, Eye, EyeOff, Loader2, Star, AlertCircle, RefreshCw } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import type { AvailableModel, ModelListFailReason, ModelListReport } from "../../../../shared/types";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import { CommandItem } from "../ui-shadcn/command";
import { CommandPickerGroup } from "../ui-shadcn/command-picker";
import { Button } from "../ui-shadcn/button";
import { ProviderUsageInline } from "../app/ProviderUsageInline";
import { useProviderUsageBatchRefresh } from "../../hooks/useProviderUsage";
import { computeModelPickerDefaultExpanded, groupModelsByProvider, modelPickerSearchFilter, modelRowLabel, modelRowName, orderProviderGroups, resolveModelPickerBody } from "./sessionPickerOptions";

/**
 * 模型列表主体（收藏栏 + 供应商分组 + 已隐藏分组）+ 它的派生视图。
 *
 * 抽出来的原因：模型列表同时出现在两个容器里——Ctrl+M / 设置页的 **Dialog** 与
 * 底栏 chip 的**二级浮层**。复制一份必然漂移（收藏/隐藏/排序/用量任一改动都要改两处），
 * 因此渲染只保留这一份，两个容器各自提供外壳（标题栏 + 搜索 + Command 上下文）。
 *
 * 本组件**必须在 `<Command>` 上下文内渲染**（CommandItem/CommandPickerGroup 依赖 cmdk）。
 */

/** 模型列表加载失败原因 → 引导文案（硬失败时替换通用空态，给出可操作动作）。 */
const MODEL_LIST_FAILURE_REASON_TEXT: Record<ModelListFailReason, TranslationKey> = {
	"pi-not-found": "app.modelListFailPiNotFound",
	"version-too-old": "app.modelListFailVersionTooOld",
	"config-invalid": "app.modelListFailConfigInvalid",
	"cli-failed": "app.modelListFailCliFailed",
	"waf-blocked": "app.modelListFailWafBlocked",
	empty: "app.modelListFailEmpty",
};

/** 模型列表的展示输入（Dialog 与浮层共用；两边只提供外壳，派生走 resolveModelPickerView）。 */
export type ModelPickerSource = {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	favoriteModels?: string[];
	report?: ModelListReport | null;
	loading?: boolean;
	refreshing?: boolean;
	onRefresh?: () => void;
	backend?: UsageProbeBackend;
	recentProviders?: string[];
	providerOrder?: string[];
	hiddenProviders?: string[];
	hiddenModels?: string[];
};

/**
 * 模型列表的派生视图（纯函数，可单测）：隐藏过滤 → 收藏置顶 → 供应商分组排序 →
 * 默认展开集合 → 主体状态。
 *
 * 关键点：**Dialog 与浮层都调它**。`defaultExpandedIds` 必须由外壳传给
 * CommandPickerPanel（展开状态在 panel 的 context 里），而它依赖收藏/分组等派生值；
 * 若外壳各自实现一遍派生逻辑，两边的展开行为就会漂移。这里收口成一处。
 */
export function resolveModelPickerView(source: ModelPickerSource) {
	const favoritesSet = new Set(source.favoriteModels ?? []);
	// 隐藏开关：Pi 后端按 provider 与 model 过滤（DSH 的 route 名不参与隐藏列表）；
	// 过滤后收藏/分组/搜索都基于可见模型，隐藏供应商与隐藏模型不出现在主选择区。
	const hiddenProviderSet = new Set(source.backend === "dsh" ? [] : (source.hiddenProviders ?? []));
	const hiddenModelSet = new Set(source.backend === "dsh" ? [] : (source.hiddenModels ?? []));
	const visibleModels: AvailableModel[] = [];
	const hiddenModelList: AvailableModel[] = [];
	for (const model of source.models) {
		if (hiddenProviderSet.has(model.provider)) continue;
		const key = `${model.provider}/${model.id}`;
		if (hiddenModelSet.has(key)) {
			hiddenModelList.push(model);
		} else {
			visibleModels.push(model);
		}
	}

	// 收藏列表（从可见模型中提取，不移除原供应商分组下的显示）
	const favorites = visibleModels.filter((model) => favoritesSet.has(`${model.provider}/${model.id}`));
	favorites.sort((a, b) => {
		const ap = a.provider ?? "";
		const bp = b.provider ?? "";
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）；
	// 搜索交给 cmdk（item 的 value/keywords 同时覆盖 name/id/provider）
	const groupedModels = groupModelsByProvider(visibleModels);
	// 供应商分组顺序：用户自定义顺序优先（严格按拖拽结果），其余仍按最近使用 → 内置置顶 → 字母序；
	// 'other' 是白名单外供应商的兜底组，顺序保持最后。
	const sortedProviders = orderProviderGroups(Object.keys(groupedModels), source.recentProviders, source.providerOrder);

	// 默认展开集合（「当前选中模型可见」驱动）：只展开收藏栏 + 当前模型所在提供商，
	// 其余提供商折叠；无收藏且无当前模型时回退第一个提供商。折叠是派生状态，
	// 模型目录/收藏异步到达后，未覆盖的分组会自动按新集合生效。
	const defaultExpandedIds = new Set(
		computeModelPickerDefaultExpanded({
			favorites,
			current: source.current,
			providers: sortedProviders,
		}),
	);

	// 主体状态：加载中 / 失败或空态引导 / 模型列表（纯函数，见 sessionPickerOptions）。
	const bodyState = resolveModelPickerBody({
		modelCount: source.models.length,
		report: source.report,
		loading: source.loading,
	});

	return { favoritesSet, visibleModels, hiddenModelList, favorites, groupedModels, sortedProviders, defaultExpandedIds, bodyState };
}

/**
 * 模型列表为空时的引导块：按失败原因给出差异化建议（升级 pi / 修配置 / 配 pi 路径 / 添加模型），
 * 并附手动刷新入口（重新调用 pi --list-models）。
 * 「加载不出来」最常见两类根因：pi 版本过低（连 --list-models 都不认）与 models.json/auth.json
 * 配置损坏（CLI 与本地解析双双失败）——此前只显示"没有匹配的模型"，用户无从排查。
 */
export function ModelListStatusGuide(props: { report: ModelListReport | null; refreshing?: boolean; onRefresh?: () => void }) {
	const report = props.report;
	if (!report) return null;
	const hardFailure = !report.ok && report.reason !== null;
	const textKey = hardFailure ? MODEL_LIST_FAILURE_REASON_TEXT[report.reason as ModelListFailReason] : "app.modelListEmptyGuide";
	return (
		<div className="flex flex-col items-start gap-2.5 px-4 py-5" role="alert">
			<div className="flex items-center gap-2 text-body font-semibold text-foreground">
				<AlertCircle size={15} className={hardFailure ? "text-destructive" : "text-muted-foreground"} aria-hidden="true" />
				{hardFailure ? t("app.modelListLoadFailed") : t("app.modelListEmptyTitle")}
			</div>
			<p className="text-caption leading-relaxed text-muted-foreground">{t(textKey)}</p>
			{report.detail && <pre className="max-h-28 w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">{report.detail}</pre>}
			{props.onRefresh && (
				<Button variant="outline" size="sm" className="mt-1" onClick={props.onRefresh} disabled={props.refreshing}>
					<RefreshCw size={13} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
					{props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRetry")}
				</Button>
			)}
		</div>
	);
}

/**
 * 首次加载态：模型目录还没返回任何报告时的占位。
 * 旧实现在此状态下面板完全空白（models=[] 且 report=null 两个分支都不命中），
 * 用户以为「选择器里没有模型」；改为明确的加载提示。
 */
export function ModelListLoadingState() {
	return (
		<div className="flex items-center gap-2.5 px-4 py-5 text-caption text-muted-foreground" role="status" aria-live="polite">
			<Loader2 size={15} className="animate-pideck-spin" aria-hidden="true" />
			{t("app.modelListLoading")}
		</div>
	);
}

export type ModelPickerBodyProps = ModelPickerSource & {
	onPick: (model: AvailableModel) => void;
	/** 切换收藏状态；引导页不提供收藏操作，因此允许省略。 */
	onToggleFavorite?: (provider: string, modelId: string) => void;
	/** 切换模型隐藏状态（可直接在模型选择器中隐藏模型，也可在折叠区恢复显示）。 */
	onToggleHideModel?: (provider: string, modelId: string) => void;
	/** 紧凑度量（二级浮层 452px 用）：行高 30px、分组头 7px 13px，与原型一致。 */
	dense?: boolean;
	/**
	 * 已由调用方算好的派生视图（避免同一帧内重复分组/排序）。
	 * 缺省时本组件自行调用 resolveModelPickerView——单测与外部复用都更省事。
	 */
	view?: ReturnType<typeof resolveModelPickerView>;
};

/**
 * 模型列表主体：渲染收藏栏、供应商分组、已隐藏分组。
 *
 * 两个容器（Dialog / 二级浮层）都用它，因此收藏星、隐藏眼、选中勾、用量 trailing
 * 只有一处实现；`dense` 只影响度量（浮层按原型收紧），不改变信息结构。
 */
export function ModelPickerBody(props: ModelPickerBodyProps) {
	const { onPick, onToggleFavorite, onToggleHideModel, dense } = props;
	const view = props.view ?? resolveModelPickerView(props);
	const { favoritesSet, hiddenModelList, favorites, groupedModels, sortedProviders, bodyState } = view;

	// 供应商用量行（cc-switch inline）：打开选择器时批量 TTL 去重查询，供应商标题行右侧
	// 显示彩色剩余/百分比；查不到（未启用/不支持/失败/查询中）的分组保持干净不渲染。
	// backend 按会话后端透传（DSH 目录的 provider 是 route 名，配置/凭据在 dsh 链路）。
	const batchRefreshUsage = useProviderUsageBatchRefresh();
	const providerKey = sortedProviders.join("\n");
	useEffect(() => {
		if (providerKey) batchRefreshUsage(providerKey.split("\n"), props.backend);
	}, [providerKey, batchRefreshUsage, props.backend]);

	const renderModelRow = (model: AvailableModel, valueOverride?: string) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKeyOf(props);
		const favorited = favoritesSet.has(modelKey);
		// cmdk 用 CommandItem.value 作为选中态标识；同一模型在收藏栏和普通提供商
		// 分组各渲染一行时，value 必须唯一，否则鼠标悬停/键盘选中会让两行同时高亮。
		// data-picker-value 仍保留模型 key，供面板"当前模型滚动定位"使用。
		const itemValue = valueOverride ?? modelKey;
		// 行文案：provider/名称，单行（原双行「name + provider/ id」视觉太重，id 收进 tooltip）。
		const labels = modelRowLabel(model);
		return (
			<CommandItem
				key={itemValue}
				value={itemValue}
				data-picker-value={modelKey}
				keywords={[model.name ?? "", model.id, model.provider, modelKey]}
				onSelect={() => onPick(model)}
				className={`group items-center gap-2 rounded-md ${dense ? "min-h-[30px] px-2 py-px data-[selected=true]:bg-[var(--row-active)]" : "min-h-9 px-2.5 py-1"}`}
			>
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				{onToggleFavorite && (
					<button
						type="button"
						className={`grid shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${dense ? "size-6" : "size-7"}${favorited ? " text-amber-500" : ""}`}
						title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						aria-label={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						onClick={(e) => {
							e.stopPropagation();
							onToggleFavorite(model.provider, model.id);
						}}
					>
						<Star size={14} strokeWidth={1.8} fill={favorited ? "currentColor" : "none"} />
					</button>
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground" title={`${modelRowName(model)} · ${modelKey}`}>
					{labels}
				</span>
				{/* 隐藏模型操作按钮：悬停时显示，点击将模型放入隐藏列表 */}
				{onToggleHideModel && !favorited && (
					<button
						type="button"
						className={`invisible grid shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 transition-colors hover:bg-accent hover:text-foreground hover:opacity-100 group-hover:visible ${dense ? "size-6" : "size-7"}`}
						title={t("app.modelHide")}
						aria-label={t("app.modelHide")}
						onClick={(e) => {
							e.stopPropagation();
							onToggleHideModel(model.provider, model.id);
						}}
					>
						<EyeOff size={13} strokeWidth={1.8} />
					</button>
				)}
				{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
			</CommandItem>
		);
	};

	if (bodyState === "loading") return <ModelListLoadingState />;
	if (bodyState === "guide" && props.report) return <ModelListStatusGuide report={props.report} refreshing={props.refreshing} onRefresh={props.onRefresh} />;

	return (
		<>
			{favorites.length > 0 && (
				<CommandPickerGroup id="favorites" dense={dense} label={t("app.modelFavorites")} count={favorites.length}>
					{favorites.map((model) => renderModelRow(model, `favorites/${model.provider}/${model.id}`))}
				</CommandPickerGroup>
			)}
			{sortedProviders.map((provider) => (
				<CommandPickerGroup id={`provider:${provider}`} key={provider} dense={dense} label={provider} count={groupedModels[provider].length} countText={t("config.count.models", { count: groupedModels[provider].length })} trailing={<ProviderUsageInline provider={provider} variant="row" backend={props.backend} />}>
					{groupedModels[provider].map((model) => renderModelRow(model))}
				</CommandPickerGroup>
			))}
			{hiddenModelList.length > 0 && onToggleHideModel && (
				<CommandPickerGroup id="hidden-models" dense={dense} label={t("app.modelHiddenSection")} count={hiddenModelList.length} countText={t("app.modelHiddenCount", { count: hiddenModelList.length })}>
					{hiddenModelList.map((model) => {
						const modelKey = `${model.provider}/${model.id}`;
						// 与可见行同一套文案规则（provider/名称，单行），只是整体弱化显示。
						const labels = modelRowLabel(model);
						return (
							<CommandItem
								key={`hidden/${modelKey}`}
								value={`hidden/${modelKey}`}
								data-picker-value={modelKey}
								keywords={[model.name ?? "", model.id, model.provider, modelKey]}
								onSelect={() => onPick(model)}
								className={`group items-center gap-2 rounded-md text-muted-foreground ${dense ? "min-h-[30px] px-2 py-px data-[selected=true]:bg-[var(--row-active)]" : "min-h-9 px-2.5 py-1"}`}
							>
								<span className="min-w-0 flex-1 truncate font-mono text-control opacity-70" title={`${modelRowName(model)} · ${modelKey}`}>
									{labels}
								</span>
								<button
									type="button"
									className={`grid shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${dense ? "size-6" : "size-7"}`}
									title={t("app.modelHiddenRestore")}
									aria-label={t("app.modelHiddenRestore")}
									onClick={(e) => {
										e.stopPropagation();
										onToggleHideModel(model.provider, model.id);
									}}
								>
									<Eye size={14} strokeWidth={1.8} />
								</button>
							</CommandItem>
						);
					})}
				</CommandPickerGroup>
			)}
		</>
	);
}

/** 当前模型的 `provider/id` key（行选中态与 CommandPickerPanel 的滚动定位共用）。 */
export function currentModelKeyOf(source: Pick<ModelPickerSource, "current">): string | undefined {
	return source.current?.provider && source.current?.modelId ? `${source.current.provider}/${source.current.modelId}` : undefined;
}

/** 模型列表搜索过滤：与 Dialog 同一份实现（二级浮层的搜索框也走它）。 */
export const modelPickerFilter = modelPickerSearchFilter;
