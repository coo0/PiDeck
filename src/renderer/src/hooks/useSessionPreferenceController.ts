import { useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModel, ModelListReport, SessionRuntimeTarget } from "../../../shared/types";
import { currentSessionIdAtom, sessionRuntimeByIdAtom } from "../atoms";
import { useSessionPreferenceState } from "./useSessionPreferenceState";
import { usePendingModelApply } from "./usePendingModelApply";
import { useSessionPaneServices } from "../components/session/SessionPaneServices";
import type { ThinkingPickerLevel } from "../components/session/sessionPickerOptions";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { SessionCommandFailure, requireSessionCommand, sessionCommandFailureToast, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { resolveComposerLiveModel } from "../utils/modelPendingDisplay";
import { modelKey, pickCycleModel, pickCycleThinkingLevel, resolveFavoriteCycleCandidates, type CycleDirection } from "../utils/preferenceCycle";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY } from "../utils/chatSessionBootstrap";

/** 快捷键触发的循环目标（模型 / 思考档位）。 */
type PendingCycle = "model" | "thinking";

export type SessionPreferenceController = {
	/** 会话后端（DSH 的目录/档位来自 host catalog）：选择器与循环共用 */
	isDshSession: boolean;
	/** 模型目录（capability cache 数据源） */
	models: AvailableModel[];
	report: ModelListReport | null;
	catalogLoading: boolean;
	refreshing: boolean;
	reloadCatalog: (force?: boolean) => void;
	/** 当前生效模型（live state 优先，回退记录 / 引导页默认） */
	currentModel: { provider?: string; modelId?: string; modelName?: string };
	/** 当前模型可用档位（与思考选择器同一份，含 runtime RPC 兜底） */
	thinkingLevels: ThinkingPickerLevel[];
	/** 当前生效档位（live 优先） */
	currentThinkingLevel: string | undefined;
	/** 收藏 / 最近 / 隐藏供应商 / 隐藏模型：选择器展示 + 循环候选 */
	favoriteModels: string[];
	recentProviders: string[];
	/** 供应商自定义顺序（模型页排序结果）：选择器严格按此展示分组，DSH 与 Pi 分开。 */
	providerOrder: string[];
	dshProviderOrder: string[];
	hiddenProviders: string[];
	hiddenModels: string[];
	/** 技能选择器需要的会话身份（避免组件再订一次 record/runtime 原子） */
	projectId: string | undefined;
	agentId: string | undefined;
	toggleFavorite: (provider: string, modelId: string) => Promise<void>;
	toggleHideModel: (provider: string, modelId: string) => Promise<void>;
	/** 选择器选中：应用模型（含 busy 排队 / 需重启引导 / 降级写记录） */
	applyModel: (model: AvailableModel) => Promise<void>;
	/** 选择器选中：应用思考档位 */
	applyThinking: (level: string) => Promise<void>;
	/** 快捷键：收藏内环绕切换模型 */
	cycleModel: (direction?: CycleDirection) => Promise<void>;
	/** 快捷键：当前模型可用档位内环绕切换思考强度 */
	cycleThinking: (direction?: CycleDirection) => Promise<void>;
	/** 需要重启 Agent 才能生效的模型（选择器/循环共用确认弹窗） */
	restartTarget: { handle: SessionRuntimeTarget; model: string } | null;
	restarting: boolean;
	confirmRestart: () => Promise<void>;
	cancelRestart: () => void;
};

/**
 * 会话「模型 + 思考强度」域 controller（写侧）：应用命令 + 快捷键循环。
 *
 * 为什么单独成 hook：这些命令原本长在 ComposerPickerHost 组件里，而快捷键必须复用**同一条**
 * 应用链路（busy 排队 / needsRestart 引导重启 / runtime 不可用时降级写会话记录 /
 * 引导页写 localStorage 偏好）。复制一份必然漂移，抽出来让「选择器点击」与「快捷键循环」
 * 共用同一实现；组件只留渲染（见 ComposerPickerHost），读侧状态见 useSessionPreferenceState。
 *
 * 快捷键订阅放在这里而不是 App：命令依赖本栏的 record/runtime/目录，且要求「只有聚焦栏响应」
 * （分屏时两栏各挂一份 controller，靠 currentSessionIdAtom 比对去重）。
 */
export function useSessionPreferenceController(options: {
	sessionId: string;
	/** 选择器是否打开（模型目录加载开关之一） */
	pickerOpen: boolean;
	/** 思考选择器是否打开（决定要不要向运行中 Agent 校验精确档位） */
	thinkingPickerOpen: boolean;
	/**
	 * 浮层（底栏 chip 的一级/二级）是否打开。
	 *
	 * 与 pickerOpen 分开是因为二者是**不同入口**：pickerOpen 指 Ctrl+M 的 Dialog，
	 * 本项指 chip 浮层。但二级视图同样需要模型目录，所以任一为真都要加载目录
	 * （目录是懒加载的，不武装就会打开二级看到空列表）。
	 */
	popoverOpen?: boolean;
	/** DSH 部署默认模型（草稿期高亮） */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	defaultThinkingLevel?: string;
	/** 应用成功后关闭选择器（选择器点击路径需要；快捷键路径幂等） */
	onApplied: () => void;
}): SessionPreferenceController {
	const { sessionId, onApplied } = options;
	const store = useStore();
	/** 快捷键首次按下才武装目录加载：避免每个会话栏开机就拉一次模型列表。 */
	const [cycleArmed, setCycleArmed] = useState(false);
	const [restartTarget, setRestartTarget] = useState<{
		handle: SessionRuntimeTarget;
		model: string;
	} | null>(null);
	const [restarting, setRestarting] = useState(false);
	const state = useSessionPreferenceState({
		sessionId,
		pickerOpen: options.pickerOpen || options.popoverOpen === true,
		thinkingPickerOpen: options.thinkingPickerOpen || options.popoverOpen === true,
		cycleArmed,
		defaultModel: options.defaultModel,
		defaultThinkingLevel: options.defaultThinkingLevel,
	});
	const { record, runtime, runtimeLive, isDshSession, models, favoriteModels, favoritesLoaded, hiddenProviders, hiddenModels, modelPending, currentModel: resolvedLiveModel, thinkingLevels, currentThinkingLevel } = state;
	// 与 Tab 栏「重启」共用 App.restartActiveAgent：置 restartingAgentId，
	// SessionView overlay（loader + 文案）才会亮。这里自己调 restartRuntime
	// 能换进程，但不会驱动那套 UI 状态。
	const { restartActiveAgent } = useSessionPaneServices();
	// 不跟 restartTarget state 同步：ConfirmDialog 点确定会先 onOpenChange(false)
	// 走 onCancel 清掉 state；确认意图放 ref，避免当成取消后丢数据。
	const restartIntentRef = useRef<{
		agentId: string;
		provider: string;
		modelId: string;
	} | null>(null);

	function currentHandle() {
		return toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeByIdAtom)[sessionId]);
	}

	/**
	 * 运行时代理命令失败时，若错误是「运行时不可用/绑定已变化」（例如 Agent 已被关闭、
	 * 或历史会话尚未启动 Agent），降级为只更新会话记录。Agent 下次启动时
	 * SessionRuntimeCoordinator.applyPreferences 会把记录里的模型应用到新进程。
	 */
	function isStaleRuntimeFailure(error: unknown): boolean {
		return error instanceof SessionCommandFailure && (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED");
	}

	async function applyModelToRecord(model: AvailableModel) {
		const updated = await desktopApi.sessions.updateRecord(sessionId, {
			model: { provider: model.provider, modelId: model.id },
		});
		state.upsertSession(updated);
	}

	function currentLiveModel() {
		// pending「from」只取 live state / catalog，不掺欢迎页兜底，避免把草稿偏好当成已生效模型。
		return resolveComposerLiveModel({
			state: runtime?.state,
			record: record?.model,
			isLive: runtimeLive,
		});
	}

	function markModelPending(model: AvailableModel) {
		const live = currentLiveModel();
		const from = modelPending?.from ?? {
			provider: live.provider,
			modelId: live.modelId,
			modelName: live.modelName,
		};
		if (from.provider === model.provider && from.modelId === model.id) {
			state.setModelPending(undefined);
			return;
		}
		state.setModelPending({
			from,
			to: {
				provider: model.provider,
				modelId: model.id,
				modelName: model.name ?? model.id,
			},
		});
	}

	function offerModelRestart(handle: SessionRuntimeTarget, model: AvailableModel) {
		onApplied();
		restartIntentRef.current = {
			agentId: handle.agentId,
			provider: model.provider,
			modelId: model.id,
		};
		setRestartTarget({
			handle,
			model: modelKey(model.provider, model.id),
		});
	}

	usePendingModelApply({
		sessionId,
		runtime,
		modelPending,
		applyRuntimeModelState: state.patchRuntimeState,
		clearPending: () => state.setModelPending(undefined),
		offerRestart: offerModelRestart,
	});

	/**
	 * 后端明确返回 busy 时才排队模型切换；支持运行中选择的 Pi/DSH 会直接在当前 runtime
	 * 入口应用，已发出的请求继续使用原配置，后续 step 使用新配置。
	 */
	async function pickModelWhileBusy(handle: SessionRuntimeTarget, model: AvailableModel) {
		try {
			const listed = requireSessionCommand(await desktopApi.sessions.listRuntimeModels(handle));
			const snapshotHasModel = listed.value.some((item) => item.provider === model.provider && item.id === model.id);
			if (!snapshotHasModel) {
				offerModelRestart(handle, model);
				return;
			}
		} catch {
			// 查快照失败（含生成中 busy）不挡选择：先记下，本轮结束后 setRuntimeModel 再判断要不要重启。
		}
		await applyModelToRecord(model);
		markModelPending(model);
		onApplied();
	}

	async function applyModel(model: AvailableModel) {
		// 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
		// 引导页 dsh 态例外：DSH 模型由部署默认决定（applyPreferences 对 dsh 草稿的
		// 模型偏好会优雅降级），不把 DSH 目录里的选择写进 pi 侧 welcome 偏好。
		if (!record) {
			if (!isDshSession) {
				try {
					localStorage.setItem(
						WELCOME_MODEL_KEY,
						JSON.stringify({
							provider: model.provider,
							modelId: model.id,
						}),
					);
				} catch {
					// localStorage 不可用时静默；创建会话回退到 pi 默认模型
				}
			}
			onApplied();
			return;
		}
		const handle = currentHandle();
		try {
			if (handle) {
				try {
					const result = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(handle, model.provider, model.id));
					const appliedModel = result.value.provider && result.value.modelId ? { provider: result.value.provider, modelId: result.value.modelId } : { provider: model.provider, modelId: model.id };
					state.upsertSession({
						...record,
						model: appliedModel,
						updatedAt: Date.now(),
					});
					state.setModelPending(undefined);
					// 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
					// 使底部栏的模型名称、provider 即刻刷新，无需等待 emitState 事件
					state.patchRuntimeState(result.value);
				} catch (error) {
					if (error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_BUSY") {
						await pickModelWhileBusy(handle, model);
						return;
					}
					// 运行时代理不可用（Agent 已关/绑定已换）时降级写记录，
					// 保证「先选模型、后启动 Agent」的流程始终可用。
					if (!isStaleRuntimeFailure(error)) throw error;
					await applyModelToRecord(model);
				}
			} else {
				await applyModelToRecord(model);
			}
			onApplied();
		} catch (error) {
			// 模型在本地 models.json 存在但运行中 Agent 快照未加载（pi set_model 校验失败）：
			// 关闭选择器并提示用户重启 Agent 使新模型生效，而非直接报错。
			if (error instanceof SessionCommandFailure && error.needsRestart && handle) {
				offerModelRestart(handle, model);
				return;
			}
			// 附带 debugDetails：DSH selectModel 拒绝（如 reasoningEffort 不被模型支持）时
			// 把真实原因展示给用户，而不是只看到泛化的「会话操作失败，请重试。」
			showNotice(sessionCommandFailureToast(error), 4000);
		}
	}

	async function applyThinking(level: string) {
		// 引导页只有 renderer-only 虚拟会话，尚无 catalog record 可更新。先保存本次
		// 显式选择，底栏关闭选择器后立即从同一偏好重绘；首次发送创建真实会话时再带入。
		if (!record) {
			try {
				localStorage.setItem(WELCOME_THINKING_KEY, level);
			} catch {
				// localStorage 不可用时静默；首次创建会话会回退到配置默认档位。
			}
			onApplied();
			return;
		}
		const handle = currentHandle();
		try {
			if (handle) {
				try {
					const result = requireSessionCommand(await desktopApi.sessions.setRuntimeThinking(handle, level));
					const agentState = result.value;
					// runtime state carries the host-confirmed effort (DSH may normalize it);
					// fall back to the requested value only for runtimes without a selected model.
					const appliedThinkingLevel = agentState.thinkingLevel ?? level;
					state.upsertSession({ ...record, thinkingLevel: appliedThinkingLevel, updatedAt: Date.now() });
					// 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
					// 使底部栏的思考强度即刻刷新
					state.patchRuntimeState(agentState);
				} catch (error) {
					// 与模型选择同一策略：运行时不可用时降级为写记录，启动时生效
					if (!isStaleRuntimeFailure(error)) throw error;
					const updated = await desktopApi.sessions.updateRecord(sessionId, {
						thinkingLevel: level,
					});
					state.upsertSession(updated);
				}
			} else {
				const updated = await desktopApi.sessions.updateRecord(sessionId, {
					thinkingLevel: level,
				});
				state.upsertSession(updated);
			}
			onApplied();
		} catch (error) {
			// 附带 debugDetails：DSH setThinking 的 selectModel 被 host 拒绝（如当前模型
			// 不支持该档位）时，把真实原因展示给用户，而不是只看到「会话操作失败，请重试。」
			showNotice(sessionCommandFailureToast(error), 4000);
		}
	}

	// 快捷键回调持最新实现：监听器只注册一次，避免依赖变化反复退订/重订。
	const applyModelRef = useRef(applyModel);
	applyModelRef.current = applyModel;
	const applyThinkingRef = useRef(applyThinking);
	applyThinkingRef.current = applyThinking;

	/**
	 * 快捷键循环：只在「收藏」里换（pi 的 scoped models → PiDeck 的收藏）。
	 * 候选经目录/隐藏供应商过滤（resolveFavoriteCycleCandidates），无可切换目标时给提示而不是静默无反应。
	 */
	const cycleModel = useCallback(
		async (direction: CycleDirection = "forward") => {
			const currentKey = resolvedLiveModel.provider && resolvedLiveModel.modelId ? modelKey(resolvedLiveModel.provider, resolvedLiveModel.modelId) : undefined;
			const candidates = resolveFavoriteCycleCandidates({
				favorites: favoriteModels,
				models,
				hiddenProviders,
				hiddenModels,
				backend: isDshSession ? "dsh" : "pi",
			});
			if (candidates.length === 0) {
				showNotice(t("app.cycleModelEmpty"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			if (candidates.length === 1) {
				const only = candidates[0];
				// 只有 1 个收藏时：不是当前模型就直接切过去（比 pi 的「Only one model in scope」更有用），
				// 已经是当前模型才提示用户多收藏几个。
				if (modelKey(only.provider, only.id) !== currentKey) await applyModelRef.current(only);
				else showNotice(t("app.cycleModelSingle"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			const target = pickCycleModel({ candidates, currentKey, direction });
			if (target) await applyModelRef.current(target);
		},
		[resolvedLiveModel.provider, resolvedLiveModel.modelId, favoriteModels, models, hiddenProviders, hiddenModels, isDshSession],
	);

	/**
	 * 快捷键循环：在当前模型可用档位里环绕（档位表与思考选择器同源）。
	 * 应用后的档位以后端返回为准（pi 会按模型能力 clamp），因此底栏展示始终是真实生效值。
	 */
	const cycleThinking = useCallback(
		async (direction: CycleDirection = "forward") => {
			const next = pickCycleThinkingLevel({
				levels: thinkingLevels,
				current: currentThinkingLevel,
				direction,
			});
			if (!next) {
				showNotice(t("app.cycleThinkingUnsupported"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			await applyThinkingRef.current(next);
		},
		[thinkingLevels, currentThinkingLevel],
	);

	const cycleModelRef = useRef(cycleModel);
	cycleModelRef.current = cycleModel;
	const cycleThinkingRef = useRef(cycleThinking);
	cycleThinkingRef.current = cycleThinking;

	/**
	 * 快捷键待执行队列：首次按键时目录/收藏可能还没加载（目录刻意懒加载），这里记下意图，
	 * 等 models + favorites 就绪后再执行；目录加载完成但仍为空则放弃并提示。
	 */
	const pendingCycleRef = useRef<PendingCycle | null>(null);
	const catalogReady = models.length > 0;
	useEffect(() => {
		const pending = pendingCycleRef.current;
		if (!pending || !favoritesLoaded) return;
		if (!catalogReady) {
			if (state.report !== null && !state.catalogLoading) {
				pendingCycleRef.current = null;
				showNotice(t("app.cycleModelCatalogFailed"), 3000, "warning", undefined, undefined, "preference-cycle");
			}
			return;
		}
		pendingCycleRef.current = null;
		if (pending === "model") void cycleModelRef.current("forward");
		else void cycleThinkingRef.current("forward");
	}, [favoritesLoaded, catalogReady, state.catalogLoading, state.report]);

	useEffect(() => {
		return desktopApi.app.onShortcutTriggered((id) => {
			if (id !== "cycleModel" && id !== "cycleThinking") return;
			// 只由聚焦栏响应：分屏时两个会话栏各挂一份 controller，不能让两栏都切一遍
			if (store.get(currentSessionIdAtom) !== sessionId) return;
			if (!catalogReady || !favoritesLoaded) {
				setCycleArmed(true);
				pendingCycleRef.current = id === "cycleModel" ? "model" : "thinking";
				return;
			}
			if (id === "cycleModel") void cycleModelRef.current("forward");
			else void cycleThinkingRef.current("forward");
		});
	}, [sessionId, store, catalogReady, favoritesLoaded]);

	async function confirmRestart() {
		const intent = restartIntentRef.current;
		if (!intent || restarting) return;
		setRestarting(true);
		// 先关确认框，避免 AlertDialog 关闭动画盖住 overlay。
		setRestartTarget(null);
		try {
			const updated = await desktopApi.sessions.updateRecord(sessionId, {
				model: { provider: intent.provider, modelId: intent.modelId },
			});
			state.upsertSession(updated);
			state.setModelPending(undefined);
			await restartActiveAgent(intent.agentId);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			restartIntentRef.current = null;
			setRestarting(false);
		}
	}

	function cancelRestart() {
		// 只关框：点确定也会先走 onOpenChange(false)→onCancel。
		// 不能在这里清 restartIntentRef，否则确认路径读到空、重启不会发生。
		setRestartTarget(null);
	}

	// 不做 memo：本 controller 只服务一个选择器宿主组件，缓存对象反而要靠 ref 兜住
	// 大量回调的最新闭包；直接返回当次渲染的引用更不容易出「点了没反应」的陈旧闭包。
	return {
		isDshSession,
		models,
		report: state.report,
		catalogLoading: state.catalogLoading,
		refreshing: state.refreshing,
		reloadCatalog: state.reloadCatalog,
		currentModel: resolvedLiveModel,
		thinkingLevels,
		currentThinkingLevel,
		favoriteModels,
		recentProviders: state.recentProviders,
		providerOrder: state.providerOrder,
		dshProviderOrder: state.dshProviderOrder,
		hiddenProviders,
		hiddenModels,
		projectId: state.projectId,
		agentId: state.agentId,
		toggleFavorite: state.toggleFavorite,
		toggleHideModel: state.toggleHideModel,
		applyModel: (model) => applyModelRef.current(model),
		applyThinking: (level) => applyThinkingRef.current(level),
		cycleModel,
		cycleThinking,
		restartTarget,
		restarting,
		confirmRestart,
		cancelRestart,
	};
}
