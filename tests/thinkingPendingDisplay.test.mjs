import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeThinkingDisplay, resolveComposerThinkingLevel } = loadTsCommonJs("src/renderer/src/utils/thinkingDisplay.ts");

// vm realm 对象原型与测试 realm 不同，deepStrictEqual 会误判，改用 JSON 比较
function assertDisplay(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

/**
 * 思考档位的展示与模型选择同源：会话/引导页偏好是唯一权威，运行态只负责执行。
 */
test("computeThinkingDisplay: 有当前档位时展示当前档位", () => {
	assertDisplay(computeThinkingDisplay("xhigh"), {
		levels: ["xhigh"],
		pending: false,
	});
});

test("computeThinkingDisplay: 无任何档位信息时返回空序列", () => {
	assertDisplay(computeThinkingDisplay(undefined), {
		levels: [],
		pending: false,
	});
});

test("resolveComposerThinkingLevel: 会话保存的选择优先于 runtime 和 fallback", () => {
	assert.equal(
		resolveComposerThinkingLevel({
			state: "xhigh",
			record: "max",
			fallback: "off",
			isLive: true,
		}),
		"max",
	);
});

test("resolveComposerThinkingLevel: 无会话记录时只使用引导页 fallback", () => {
	assert.equal(
		resolveComposerThinkingLevel({
			state: "xhigh",
			fallback: "off",
			isLive: true,
		}),
		"off",
	);
});

test("契约: thinking 按钮运行中可点，启动中禁用", () => {
	const components = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const popover = readFileSync("src/renderer/src/components/session/ModelEffortPopover.tsx", "utf8");
	// 模板/模式仍随 disabled 禁用；thinking / 模型按钮有独立禁用位。
	// 思考档位入口已从 chip 的两行菜单改为浮层滑块，禁用位随之改名
	// （thinkingDisabled → effortDisabled），语义不变：启动中禁用、运行中可点。
	assert.match(components, /disabled=\{props\.disabled\}/);
	assert.match(components, /effortDisabled=\{props\.thinkingDisabled\}/);
	assert.match(components, /disabled=\{props\.modelDisabled \?\? props\.disabled\}/);
	// 浮层把禁用位接到滑块（pill 与滑块共用同一开关）
	assert.match(popover, /effortDisabled\?: boolean/);
	assert.match(popover, /disabled=\{props\.effortDisabled\}/);
	assert.doesNotMatch(components, /thinkingPending|ThinkingLevelPending|thinkingDisplay\.levels\.map/);
});

test("契约: ComposerArea 不预先限制运行中的思考强度修改", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// Pi/DSH 是否支持当前回合由后端决定，renderer 只在启动中禁用入口。
	assert.match(area, /disabled=\{composer\.isStarting\}/);
	assert.match(area, /thinkingDisabled=\{composer\.isStarting\}/);
	assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
});

/** 保留 hook 生命周期，直接执行生产 controller 与 pending hook，不模拟命令结果处理。 */
function createThinkingControllerHarness() {
	const slots = [];
	let cursor = 0;
	let effects = [];
	const react = {
		useRef(value) {
			return (slots[cursor++] ??= { current: value });
		},
		useState(value) {
			const index = cursor++;
			slots[index] ??= { value };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = next;
				},
			];
		},
		useCallback: (callback) => callback,
		useEffect(callback, dependencies) {
			const index = cursor++;
			const previous = slots[index];
			if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
			effects.push(() => {
				previous?.cleanup?.();
				slots[index] = { dependencies, cleanup: callback() };
			});
		},
	};
	const atoms = { currentSessionIdAtom: Symbol(), sessionRuntimeByIdAtom: Symbol(), modelPendingByIdAtom: Symbol() };
	const calls = [],
		writes = [],
		notices = [],
		restarts = [];
	let appliedCount = 0;
	const model = { provider: "test", id: "next", name: "Next" };
	const state = {
		record: { id: "s", status: "active", thinkingLevel: "low", model: { provider: "test", modelId: "old" } },
		runtime: { agentId: "a", runtimeGeneration: 1, status: "running" },
		models: [model],
		favoriteModels: [],
		hiddenProviders: [],
		hiddenModels: [],
		thinkingLevels: [],
		currentModel: { provider: "test", modelId: "old" },
		modelPending: undefined,
		upsertSession(record) {
			writes.push(record);
			state.record = record;
		},
		setModelPending(pending) {
			state.modelPending = pending;
		},
	};
	const api = {
		setRuntimeThinking: async (...args) => {
			calls.push(args);
			return { ok: true, value: { value: { thinkingLevel: "medium" } } };
		},
		setRuntimeModel: async () => ({ ok: false, error: { code: "SESSION_RUNTIME_BUSY" } }),
		listRuntimeModels: async () => ({ ok: true, value: { value: [] } }),
		updateRecord: async (id, patch) => ({ ...state.record, ...patch }),
	};
	const load = createTsSandbox({
		stubs: {
			react,
			jotai: { useStore: () => ({ get: (atom) => (atom === atoms.sessionRuntimeByIdAtom ? { s: state.runtime } : atom === atoms.modelPendingByIdAtom ? { s: state.modelPending } : "s") }) },
			"../atoms": atoms,
			"./useSessionPreferenceState": { useSessionPreferenceState: () => state },
			"../components/session/SessionPaneServices": { useSessionPaneServices: () => ({ restartActiveAgent: async (agentId) => restarts.push({ sessionId: state.record.id, agentId, runtimeGeneration: state.runtime.runtimeGeneration }) }) },
			"../components/session/sessionPickerOptions": { resolveThinkingPickerLevels: () => [] },
			"../desktopApi": { desktopApi: { sessions: api, app: { onShortcutTriggered: () => () => {} } } },
			"../utils/notice": { showNotice: (...args) => notices.push(args) },
			"../i18n": { t: (key) => key },
			"../atoms/welcome-preference-atoms": {},
			"../utils/chatSessionBootstrap": {},
		},
	});
	const { useSessionPreferenceController } = load("src/renderer/src/hooks/useSessionPreferenceController.ts");
	return {
		state,
		api,
		calls,
		writes,
		notices,
		restarts,
		model,
		get appliedCount() {
			return appliedCount;
		},
		render() {
			cursor = 0;
			effects = [];
			const controller = useSessionPreferenceController({
				sessionId: "s",
				pickerOpen: true,
				thinkingPickerOpen: true,
				onApplied() {
					appliedCount++;
				},
			});
			for (const effect of effects) effect();
			return controller;
		},
		dispose() {
			for (const slot of slots) slot?.cleanup?.();
		},
	};
}

const flushThinkingEffects = () => new Promise((resolve) => setImmediate(resolve));

test("thinking 即时切换写后端规范化实际档位而不是请求档位", async (t) => {
	const h = createThinkingControllerHarness();
	t.after(() => h.dispose());
	await h.render().applyThinking("xhigh");
	assertDisplay(h.calls, [[{ sessionId: "s", agentId: "a", runtimeGeneration: 1 }, "xhigh"]]);
	assert.equal(h.state.record.thinkingLevel, "medium");
	assert.equal(h.writes.length, 1);
	assert.equal(h.appliedCount, 1);
	assert.equal(h.notices.length, 0);
});

test("thinking 仅 undefined 旧后端字段回退请求档位，实际值不擅自 trim", async (t) => {
	const h = createThinkingControllerHarness();
	t.after(() => h.dispose());
	h.api.setRuntimeThinking = async () => ({ ok: true, value: { value: {} } });
	await h.render().applyThinking("high");
	assert.equal(h.state.record.thinkingLevel, "high");
	h.api.setRuntimeThinking = async () => ({ ok: true, value: { value: { thinkingLevel: " medium " } } });
	await h.render().applyThinking("xhigh");
	assert.equal(h.state.record.thinkingLevel, " medium ");
});

for (const invalid of [null, 3, "", "  "]) {
	test(`thinking 无效返回 ${JSON.stringify(invalid)} 不写请求档位或报成功`, async (t) => {
		const h = createThinkingControllerHarness();
		t.after(() => h.dispose());
		h.api.setRuntimeThinking = async () => ({ ok: true, value: { value: { thinkingLevel: invalid } } });
		await h.render().applyThinking("high");
		assert.equal(h.state.record.thinkingLevel, "low");
		assert.equal(h.writes.length, 0);
		assert.equal(h.appliedCount, 0);
		assert.equal(h.notices.length, 1);
		assert.equal(h.state.modelPending, undefined);
	});
}

for (const errorCode of ["SESSION_COMMAND_FAILED", "SESSION_RUNTIME_BUSY", "SESSION_RUNTIME_UNAVAILABLE", "SESSION_RUNTIME_CHANGED"]) {
	test(`thinking ${errorCode} 不降级写记录`, async (t) => {
		const h = createThinkingControllerHarness();
		t.after(() => h.dispose());
		h.api.setRuntimeThinking = async () => ({ ok: false, error: { code: errorCode } });
		await h.render().applyThinking("high");
		assert.equal(h.writes.length, 0);
		assert.equal(h.appliedCount, 0);
		assert.equal(h.notices.length, errorCode === "SESSION_COMMAND_FAILED" || errorCode === "SESSION_RUNTIME_BUSY" ? 1 : 0);
	});
}

for (const runtime of [
	{ agentId: "b", runtimeGeneration: 1, status: "idle" },
	{ agentId: "a", runtimeGeneration: 2, status: "idle" },
]) {
	test(`thinking runtime 换代迟到结果拒绝 ${runtime.agentId}/${runtime.runtimeGeneration}`, async (t) => {
		const h = createThinkingControllerHarness();
		t.after(() => h.dispose());
		let finish;
		h.api.setRuntimeThinking = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const pending = h.render().applyThinking("high");
		await flushThinkingEffects();
		h.state.runtime = runtime;
		h.render();
		finish({ ok: true, value: { value: { thinkingLevel: "medium" } } });
		await pending;
		assert.equal(h.writes.length, 0);
		assert.equal(h.appliedCount, 0);
		assert.equal(h.notices.length, 0);
	});
}

test("thinking 未绑定 runtime 才允许记录 fallback", async (t) => {
	const h = createThinkingControllerHarness();
	t.after(() => h.dispose());
	h.state.runtime = undefined;
	await h.render().applyThinking("high");
	assert.equal(h.state.record.thinkingLevel, "high");
	assert.equal(h.calls.length, 0);
});

test("模型 busy 排队期间 thinking 由同一 owner 保存，idle 重试才应用", async (t) => {
	const h = createThinkingControllerHarness();
	t.after(() => h.dispose());
	let busy = true;
	let modelCalls = 0;
	h.api.listRuntimeModels = async () => ({ ok: true, value: { value: [h.model] } });
	h.api.setRuntimeModel = async () => {
		modelCalls++;
		return busy ? { ok: false, error: { code: "SESSION_RUNTIME_BUSY" } } : { ok: true, value: { value: { provider: "test", modelId: "next", modelName: "Next" } } };
	};
	h.api.setRuntimeThinking = async (...args) => {
		h.calls.push(args);
		return { ok: true, value: { value: { thinkingLevel: "high" } } };
	};
	await h.render().applyModel(h.model);
	await h.render().applyThinking("high");
	assert.equal(h.state.modelPending.thinking.to, "high");
	assert.equal(h.state.record.thinkingLevel, "low");
	assert.equal(h.calls.length, 0);
	h.render();
	await flushThinkingEffects();
	assert.equal(modelCalls, 1);
	busy = false;
	h.state.runtime = { ...h.state.runtime, status: "idle" };
	h.render();
	await flushThinkingEffects();
	assert.equal(modelCalls, 2);
	assert.equal(h.state.modelPending, undefined);
	assert.equal(h.state.record.thinkingLevel, "high");
	assert.equal(h.calls.length, 1);
	assert.equal(h.notices.length, 0);
});

test("重启确认传当前 agent 给共享 overlay 入口并拒绝旧 runtime triple", async (t) => {
	for (const stale of [false, true]) {
		const h = createThinkingControllerHarness();
		t.after(() => h.dispose());
		await h.render().applyModel(h.model);
		const controller = h.render();
		assertDisplay(controller.restartTarget.handle, { sessionId: "s", agentId: "a", runtimeGeneration: 1 });
		if (stale) {
			h.state.runtime = { agentId: "a", runtimeGeneration: 2, status: "idle" };
			h.render();
		}
		await controller.confirmRestart();
		assertDisplay(h.restarts, stale ? [] : [{ sessionId: "s", agentId: "a", runtimeGeneration: 1 }]);
		assert.equal(h.writes.length, stale ? 0 : 1);
	}
});
