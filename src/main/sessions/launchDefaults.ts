import type { ResolveLaunchDefaultsInput, ResolvedLaunchDefaults } from "../../shared/types";
import { createSessionModelPreference } from "../../shared/modelDisplayName";

/** 手选 > 系统默认 > Pi 首模型；已发布快照（包括空目录）是模型有效性的权威来源。
 * 快照未就绪才使用 models.json。思考强度独立解析，并始终基于最终选择的模型。
 */
export function resolveLaunchDefaultOptions(input: {
	backend?: ResolveLaunchDefaultsInput["backend"];
	settings: unknown;
	models: unknown;
	/** 桌面端记录的「用户最后一次使用的模型」（userData/settings.json 的 lastUsedModel）。 */
	lastUsedModel?: unknown;
	/** 渲染层欢迎页（引导页）偏好模型；仅在无显式默认时参与回退。 */
	welcomeModel?: unknown;
	/** 创建请求已明确选择的模型，优先于欢迎页与配置默认。 */
	model?: unknown;
	/** Pi capability snapshot（来自现有 stdio/RPC 探测），用于选择当前模型首个可用思考档位。 */
	capabilities?: unknown;
}): ResolvedLaunchDefaults {
	const defaults: ResolvedLaunchDefaults = {};
	const models = modelDirectory(input.models, input.capabilities);
	if (input.backend !== "dsh") {
		// 显式默认只解析一次：defaultModelConfigured 仅作「是否存在有效显式默认」的诊断标记
		// 返回（供文案/排查用）；渲染层展示不再拿它当闸门——展示与创建统一按点选优先。
		const explicit = strictModelPair(input.settings, models);
		if (explicit) defaults.defaultModelConfigured = true;
		// 仅在解析成功时落键：空结果必须是真 {}，调用方才能用 presence 判断是否预选
		// 优先级：欢迎页手选 > Pi 系统显式默认 > capability 首模型 > models.json 首模型。
		// enabledModels/lastUsed 只用于旧链路兼容，不参与无会话默认回退。
		const model = welcomeModelOfModelsConfig(input.model, models) ?? welcomeModelOfModelsConfig(input.welcomeModel, models) ?? explicit ?? firstModelOfModelsConfig(models);
		if (model) defaults.model = model;
	}
	const thinkingLevel = nonBlankString(input.settings, "defaultThinkingLevel") ?? firstThinkingLevel(input.capabilities, defaults.model);
	if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
	return defaults;
}

/**
 * settings.defaultProvider/defaultModel 同时为字符串、且两者确实存在于 models.json
 * 才算有效配对（避免半配置进入回退歧义；避免默认指向已删除的供应商/模型）。
 */
function strictModelPair(settings: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	const provider = optionalString(settings, "defaultProvider");
	const modelId = optionalString(settings, "defaultModel");
	if (!provider || !modelId) return undefined;
	return modelPreferenceFromModelsConfig(models, provider, modelId);
}

/** 显式传入的 model（如欢迎页偏好）是否存在：不存在视为无效，调用方应回退解析默认。 */
export function isModelInModelsConfig(models: unknown, model: { provider: string; modelId: string }, capabilities?: unknown): boolean {
	return modelExistsInModelsConfig(modelDirectory(models, capabilities), model.provider, model.modelId);
}

/** 将 Pi 已发布模型快照适配为配置目录形状；[] 不能回落到残留配置。 */
function modelDirectory(models: unknown, capabilities: unknown): unknown {
	if (!Array.isArray(capabilities)) return models;
	const providers: Record<string, { models: Array<{ id: string; name?: unknown }> }> = Object.create(null);
	for (const model of capabilities) {
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) continue;
		(providers[model.provider] ??= { models: [] }).models.push({ id: model.id, name: model.name });
	}
	return { providers };
}

function firstModelOfModelsConfig(models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(models) || !isRecord(models.providers)) return undefined;
	for (const [provider, entry] of Object.entries(models.providers)) {
		if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
		for (const model of entry.models) {
			if (isRecord(model) && typeof model.id === "string" && model.id) return createSessionModelPreference(provider, model.id, model.name);
		}
	}
	return undefined;
}

/** 能力快照就绪时使用当前模型首个可用档位；探测尚未完成才回退兼容首档。 */
function firstThinkingLevel(capabilities: unknown, model: ResolvedLaunchDefaults["model"]): string {
	if (Array.isArray(capabilities) && model) {
		const entry = capabilities.find((candidate) => isRecord(candidate) && candidate.provider === model.provider && candidate.id === model.modelId);
		if (isRecord(entry) && Array.isArray(entry.thinkingLevels)) {
			const first = entry.thinkingLevels.find((level) => typeof level === "string" && level.trim());
			if (typeof first === "string") return first;
		}
	}
	return "off";
}

function modelPreferenceFromModelsConfig(models: unknown, provider: string, modelId: string): ResolvedLaunchDefaults["model"] {
	if (!isRecord(models)) return undefined;
	const providers = models.providers;
	if (!isRecord(providers)) return undefined;
	const providerEntry = providers[provider];
	if (!isRecord(providerEntry) || !Array.isArray(providerEntry.models)) return undefined;
	const model = providerEntry.models.find((candidate) => isRecord(candidate) && candidate.id === modelId);
	if (!isRecord(model)) return undefined;
	return createSessionModelPreference(provider, modelId, model.name);
}

/** 模型是否存在于 models.json（provider 键 + models 数组 id 精确匹配）。 */
function modelExistsInModelsConfig(models: unknown, provider: string, modelId: string): boolean {
	if (!isRecord(models)) return false;
	const providers = models.providers;
	if (!isRecord(providers)) return false;
	const providerEntry = providers[provider];
	if (!isRecord(providerEntry) || !Array.isArray(providerEntry.models)) return false;
	return providerEntry.models.some((model) => isRecord(model) && model.id === modelId);
}

/** 欢迎页偏好模型：必须形如 { provider, modelId } 且仍存在于 models.json，否则视为无偏好。 */
function welcomeModelOfModelsConfig(welcome: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(welcome)) return undefined;
	const provider = welcome.provider;
	const modelId = welcome.modelId;
	if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
	if (!provider || !modelId || !modelExistsInModelsConfig(models, provider, modelId)) return undefined;
	// 引导页已在用户点选的瞬间保存名称快照。这里只做存在性校验，不能再次以当前
	// models.json 的别名覆盖它，否则用户配置在两次操作之间更新会让底栏跳变。
	return createSessionModelPreference(provider, modelId, welcome.modelName);
}

function optionalString(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function nonBlankString(source: unknown, key: string): string | undefined {
	const value = optionalString(source, key)?.trim();
	return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
