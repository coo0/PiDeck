import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);
const jotai = require("jotai");
const { atom, createStore } = jotai;

function existingSession() {
	return { id: "existing", projectId: "project", title: "Existing", source: "pi", environment: "native", backend: "pi", preview: "", messageCount: 0, status: "draft", thinkingLevel: "medium", createdAt: 1, updatedAt: 1 };
}

// 保留真实 Jotai store/订阅，只替换 React 生命周期和与本问题无关的服务。
// onApplied 是空操作，模拟独立浮层中 picker 已为 null 的情况。
function setup({ saved, record, storageUnavailable = false, runtime, models = [], thinkingFailure = false, beforeModel, beforeThinking, modelError } = {}) {
	const values = new Map(saved ? [["pideck:welcome-thinking", saved]] : []);
	const localStorage = {
		getItem: (key) => {
			if (storageUnavailable) throw new Error("storage unavailable");
			return values.get(key) ?? null;
		},
		setItem: (key, value) => {
			if (storageUnavailable) throw new Error("storage unavailable");
			values.set(key, value);
		},
		removeItem: (key) => values.delete(key),
	};
	const store = createStore();
	const recordAtom = atom(record);
	const emptyAtom = atom(undefined);
	const noopAtom = atom(null, () => {});
	const updates = [];
	const settingsUpdates = [];
	const commands = [];
	const notices = [];
	const restarts = [];
	const atoms = {
		matchesPiRuntimeThinkingLevelsTarget: () => false,
		sessionRecordByIdAtomFamily: () => recordAtom,
		sessionRuntimeBySessionIdAtomFamily: () => atom(runtime),
		piRuntimeThinkingLevelsBySessionIdAtomFamily: () => emptyAtom,
		modelPendingByIdAtom: atom({}),
		sessionRuntimeByIdAtom: atom(runtime ? { [record.id]: runtime } : {}),
		currentSessionIdAtom: atom("renderer:guide-bootstrap"),
		upsertSessionAtom: atom(null, (_get, set, next) => set(recordAtom, next)),
		beginPiRuntimeThinkingLevelsAtom: noopAtom,
		clearPiRuntimeThinkingLevelsAtom: noopAtom,
		resolvePiRuntimeThinkingLevelsAtom: noopAtom,
	};
	let pendingInput;
	const refs = [];
	let refIndex = 0;
	let dirty = false;
	const subscriptions = new Map();
	const sandbox = createTsSandbox({
		globals: { localStorage },
		stubs: {
			jotai: {
				...jotai,
				useStore: () => store,
				useAtomValue: (target) => {
					if (!subscriptions.has(target))
						subscriptions.set(
							target,
							store.sub(target, () => {
								dirty = true;
							}),
						);
					return store.get(target);
				},
				useSetAtom: (target) => (value) => store.set(target, value),
			},
			react: { useEffect: () => {}, useRef: (current) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }), useCallback: (fn) => fn, useState: (initial) => [initial, () => {}] },
			"../atoms": atoms,
			"../desktopApi": {
				desktopApi: {
					settings: { update: async (value) => settingsUpdates.push(value) },
					sessions: {
						setRuntimeModel: async (target, provider, id) => {
							commands.push(["model", target, id]);
							await beforeModel?.(id);
							const failure = typeof modelError === "function" ? modelError() : modelError;
							if (failure) return { ok: false, error: failure };
							return { ok: true, value: { target, value: { provider, modelId: id } } };
						},
						setRuntimeThinking: async (target, level) => {
							commands.push(["thinking", target, level]);
							await beforeThinking?.(level);
							if (thinkingFailure) throw new Error("thinking rejected");
							return { ok: true, value: { target, value: { thinkingLevel: level } } };
						},
						listRuntimeModels: async () => ({ ok: true, value: { value: models } }),
						updateRecord: async (id, patch) => {
							updates.push({ id, ...patch });
							return { ...record, ...patch };
						},
					},
				},
			},
			"../utils/notice": {
				showNotice: (message) => notices.push(message),
			},
			"../i18n": { t: (key) => key },
			"./useBackendModelCatalog": { useBackendModelCatalog: () => ({ models, report: null, loading: false, refreshing: false, reload: () => {} }) },
			"./usePendingModelApply": {
				usePendingModelApply: (input) => {
					pendingInput = input;
				},
			},
			"../components/session/SessionPaneServices": { useSessionPaneServices: () => ({ restartActiveAgent: async (agentId) => restarts.push([agentId, store.get(recordAtom)]) }) },
		},
	});
	const { useSessionPreferenceController } = sandbox("src/renderer/src/hooks/useSessionPreferenceController.ts");

	const bootstrap = sandbox("src/renderer/src/utils/chatSessionBootstrap.ts");
	const welcomeThinkingAtom = sandbox("src/renderer/src/atoms/welcome-preference-atoms.ts").welcomeThinkingLevelAtom;
	const welcomeModelAtom = sandbox("src/renderer/src/atoms/welcome-preference-atoms.ts").welcomeModelPreferenceAtom;
	const render = () => {
		refIndex = 0;
		return useSessionPreferenceController({ sessionId: record?.id ?? bootstrap.GUIDE_BOOTSTRAP_SESSION_ID, pickerOpen: false, thinkingPickerOpen: false, defaultThinkingLevel: "medium", onApplied: () => {} });
	};
	let current = render();
	return {
		get current() {
			return current;
		},
		async select(level) {
			await current.applyThinking(level);
			if (dirty) {
				dirty = false;
				current = render();
			}
		},
		async selectModel(model) {
			await current.applyModel(model);
			current = render();
		},
		async retryPending(model, isCurrent = () => true) {
			const applied = await pendingInput.applyModel({ sessionId: record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration }, model, isCurrent);
			if (applied) pendingInput.clearPending();
			current = render();
		},
		replaceRuntime(next) {
			store.set(atoms.sessionRuntimeByIdAtom, { [record.id]: next });
		},
		get pending() {
			return store.get(atoms.modelPendingByIdAtom)[record.id];
		},
		get record() {
			return store.get(recordAtom);
		},
		restarts,
		sandbox,
		notices,
		commands,
		welcomeModelAtom,
		values,
		store,
		welcomeThinkingAtom,
		updates,
		settingsUpdates,
		bootstrap,
		close: () => {
			for (const unsubscribe of subscriptions.values()) unsubscribe();
		},
	};
}

test("欢迎页在 picker 已关闭时选择思考强度立即反馈", async (t) => {
	const page = setup();
	t.after(page.close);
	await page.select("high");
	assert.equal(page.current.currentThinkingLevel, "high");
});

test("欢迎页选择保持原始字符串存储，首次发送读取最新档位", async (t) => {
	const page = setup({ saved: "low" });
	t.after(page.close);
	await page.select("max");
	assert.deepEqual([page.values.get(page.bootstrap.WELCOME_THINKING_KEY), page.bootstrap.readWelcomeThinkingPreference()?.thinkingLevel], ["max", "max"]);
});

test("重新启动读取既有欢迎页思考偏好", (t) => {
	const page = setup({ saved: "xhigh" });
	t.after(page.close);
	assert.equal(page.current.currentThinkingLevel, "xhigh");
});

test("已有会话修改只更新自身，不污染欢迎页和全局默认", async (t) => {
	const page = setup({ saved: "low", record: existingSession() });
	t.after(page.close);
	await page.select("high");
	assert.deepEqual({ level: page.current.currentThinkingLevel, saved: page.bootstrap.readWelcomeThinkingPreference()?.thinkingLevel, updates: page.updates, settings: page.settingsUpdates }, { level: "high", saved: "low", updates: [{ id: "existing", thinkingLevel: "high" }], settings: [] });
});

test("欢迎页选择不更新真实会话或全局默认", async (t) => {
	const page = setup();
	t.after(page.close);
	await page.select("off");
	assert.deepEqual([page.updates, page.settingsUpdates], [[], []]);
});

test("localStorage 不可用时欢迎页选择仍立即反馈", async (t) => {
	const page = setup({ storageUnavailable: true });
	t.after(page.close);
	await page.select("high");
	assert.equal(page.current.currentThinkingLevel, "high");
});

test("localStorage 不可用时首次创建读取欢迎页 atom 内存值", async (t) => {
	const page = setup({ storageUnavailable: true });
	t.after(page.close);
	await page.select("high");
	assert.equal(page.store.get(page.welcomeThinkingAtom), "high");
});

test("欢迎页底栏消费响应式思考档位，真实会话保留会话值优先级", () => {
	const source = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	assert.match(source, /const\s+welcomeThinkingLevel\s*=\s*useAtomValue\(\s*welcomeThinkingLevelAtom\s*\)\s*;/);
	assert.match(source, /const\s+welcomeThinking\s*=\s*!props\.record\s*\?\s*welcomeThinkingLevel\s*:\s*undefined\s*;/);
	assert.doesNotMatch(source, /!props\.record\s*\?\s*useAtomValue\(\s*welcomeThinkingLevelAtom\s*\)/);
	assert.match(source, /record:\s*props\.record\?\.thinkingLevel/);
});

const targetModel = { provider: "pi", id: "target", name: "Target", thinkingLevels: ["low", "medium", "high"] };

for (const saved of ["max", "high"]) {
	test(`换模按目标能力同步欢迎页和启动偏好：${saved}`, async (t) => {
		const page = setup({ saved, models: [targetModel] });
		t.after(page.close);
		await page.selectModel(targetModel);
		assert.deepEqual([page.current.currentThinkingLevel, page.store.get(page.welcomeThinkingAtom)], [saved === "max" ? "medium" : saved, saved === "max" ? "medium" : saved]);
	});
}

test("未绑定运行时的已有会话一次保存模型和回落档位，不污染欢迎页", async (t) => {
	const page = setup({ saved: "high", record: { ...existingSession(), thinkingLevel: "max" }, models: [targetModel] });
	t.after(page.close);
	await page.selectModel(targetModel);
	assert.deepEqual([page.current.currentThinkingLevel, page.updates.length, page.updates[0].thinkingLevel, page.store.get(page.welcomeThinkingAtom)], ["medium", 1, "medium", "high"]);
});

test("活动会话换模后显式应用回落档位，保留同一运行时目标", async (t) => {
	const runtime = { agentId: "agent", runtimeGeneration: 7, status: "idle" };
	const page = setup({ record: { ...existingSession(), thinkingLevel: "max" }, runtime, models: [targetModel] });
	t.after(page.close);
	await page.selectModel(targetModel);
	assert.deepEqual(
		[page.current.currentThinkingLevel, page.commands.map(([command, target, value]) => [command, target.sessionId, target.agentId, target.runtimeGeneration, value])],
		[
			"medium",
			[
				["model", "existing", "agent", 7, "target"],
				["thinking", "existing", "agent", 7, "medium"],
			],
		],
	);
});

test("运行时强度设置失败保留成功模型与原档位并提示", async (t) => {
	const page = setup({ record: { ...existingSession(), thinkingLevel: "max" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" }, models: [targetModel], thinkingFailure: true });
	t.after(page.close);
	await page.selectModel(targetModel);
	assert.deepEqual([page.current.currentModel.modelId, page.current.currentThinkingLevel, page.notices.length], ["target", "max", 1]);
});

test("活动会话保留目标支持的档位，不额外设置强度", async (t) => {
	const page = setup({ record: { ...existingSession(), thinkingLevel: "high" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" }, models: [targetModel] });
	t.after(page.close);
	await page.selectModel(targetModel);
	assert.deepEqual([page.current.currentThinkingLevel, page.commands.map(([kind]) => kind)], ["high", ["model"]]);
});

for (const valid of [true, false]) {
	test(`排队重试复用模型和强度应用，失效选择不执行：${valid}`, async (t) => {
		const page = setup({ record: { ...existingSession(), thinkingLevel: "max" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" }, models: [targetModel] });
		t.after(page.close);
		await page.retryPending({ provider: targetModel.provider, id: targetModel.id }, () => valid);
		assert.deepEqual([page.current.currentThinkingLevel, page.commands.map(([kind]) => kind)], valid ? ["medium", ["model", "thinking"]] : ["max", []]);
	});
}

test("换模响应到达前运行时换代，不追加旧目标强度命令或改写记录", async (t) => {
	const gate = Promise.withResolvers();
	const started = Promise.withResolvers();
	const page = setup({
		record: { ...existingSession(), thinkingLevel: "max" },
		runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" },
		models: [targetModel],
		beforeModel: async () => {
			started.resolve();
			await gate.promise;
		},
	});
	t.after(page.close);
	const selecting = page.selectModel(targetModel);
	await started.promise;
	page.replaceRuntime({ agentId: "new-agent", runtimeGeneration: 8, status: "idle" });
	gate.resolve();
	await selecting;
	assert.deepEqual([page.current.currentModel.modelId, page.current.currentThinkingLevel, page.commands.map(([kind]) => kind), page.updates], ["", "max", ["model"], []]);
});

test("快速连换模型串行完成强度回落，最终记录与最后命令一致", async (t) => {
	const gate = Promise.withResolvers();
	const started = Promise.withResolvers();
	const next = { ...targetModel, id: "next", thinkingLevels: ["low", "high"] };
	const page = setup({
		record: { ...existingSession(), thinkingLevel: "max" },
		runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" },
		models: [targetModel, next],
		beforeModel: async (id) => {
			if (id === "target") {
				started.resolve();
				await gate.promise;
			}
		},
	});
	t.after(page.close);
	const first = page.selectModel(targetModel);
	await started.promise;
	const second = page.selectModel(next);
	gate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(
		[page.current.currentModel.modelId, page.current.currentThinkingLevel, page.commands.map(([kind, , value]) => [kind, value])],
		[
			"next",
			"low",
			[
				["model", "target"],
				["thinking", "medium"],
				["model", "next"],
				["thinking", "low"],
			],
		],
	);
});

for (const stale of [false, true]) {
	test(`needsRestart 确认保存目标模型与回落档位，拒绝过期代：${stale}`, async (t) => {
		const page = setup({ record: { ...existingSession(), thinkingLevel: "max" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" }, models: [targetModel], modelError: { code: "SESSION_MODEL_NOT_FOUND", needsRestart: true } });
		t.after(page.close);
		await page.selectModel(targetModel);
		if (stale) page.replaceRuntime({ agentId: "agent", runtimeGeneration: 8, status: "idle" });
		await page.current.confirmRestart();
		assert.deepEqual([page.updates.map((patch) => [patch.model.modelId, patch.thinkingLevel]), page.restarts.map(([id, record]) => [id, record.thinkingLevel])], stale ? [[], []] : [[["target", "medium"]], [["agent", "medium"]]]);
	});
}

test("busy 期间目标模型和目标档位一致，仍保留 live 档位并显示待应用关系", async (t) => {
	let busy = true;
	const page = setup({ record: { ...existingSession(), model: { provider: "pi", modelId: "old", modelName: "Old" }, thinkingLevel: "max" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "running" }, models: [targetModel], modelError: () => (busy ? { code: "SESSION_RUNTIME_BUSY" } : undefined) });
	t.after(page.close);
	await page.selectModel(targetModel);
	const { computeThinkingDisplay, resolveComposerThinkingLevel } = page.sandbox("src/renderer/src/utils/thinkingDisplay.ts");
	const homepageLevel = resolveComposerThinkingLevel({ record: page.record.thinkingLevel, pending: page.pending?.thinking });
	const display = computeThinkingDisplay(page.record.thinkingLevel, page.pending?.thinking);
	assert.deepEqual(JSON.parse(JSON.stringify([page.current.currentModel.modelId, page.current.currentThinkingLevel, homepageLevel, display, page.record.thinkingLevel, page.commands.map(([kind]) => kind)])), ["target", "medium", "medium", { levels: ["max", "medium"], pending: true }, "max", ["model"]]);
	await page.select("high");
	assert.deepEqual([page.current.currentThinkingLevel, page.record.thinkingLevel, page.pending.thinking.to, page.commands.map(([kind]) => kind)], ["high", "max", "high", ["model"]]);
	busy = false;
	await page.retryPending(targetModel);
	assert.deepEqual([page.current.currentThinkingLevel, page.record.thinkingLevel, page.pending, page.commands.at(-1)[2]], ["high", "high", undefined, "high"]);
});

test("换模未完成时手动改强度排在回落之后，最后用户选择胜出", async (t) => {
	const gate = Promise.withResolvers();
	const started = Promise.withResolvers();
	const page = setup({
		record: { ...existingSession(), thinkingLevel: "max" },
		runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" },
		models: [targetModel],
		beforeModel: async () => {
			started.resolve();
			await gate.promise;
		},
	});
	t.after(page.close);
	const model = page.selectModel(targetModel);
	await started.promise;
	const thinking = page.select("high");
	gate.resolve();
	await Promise.all([model, thinking]);
	assert.deepEqual(
		[page.record.thinkingLevel, page.commands.map(([kind, , value]) => [kind, value])],
		[
			"high",
			[
				["model", "target"],
				["thinking", "medium"],
				["thinking", "high"],
			],
		],
	);
});

test("手动强度响应到达前换代，不回写旧目标记录", async (t) => {
	const gate = Promise.withResolvers();
	const started = Promise.withResolvers();
	const page = setup({
		record: { ...existingSession(), thinkingLevel: "max" },
		runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" },
		beforeThinking: async () => {
			started.resolve();
			await gate.promise;
		},
	});
	t.after(page.close);
	const thinking = page.select("high");
	await started.promise;
	page.replaceRuntime({ agentId: "agent", runtimeGeneration: 8, status: "idle" });
	gate.resolve();
	await thinking;
	assert.deepEqual([page.record.thinkingLevel, page.updates], ["max", []]);
});

test("手动改档位成功后即刻换模，不依赖重新渲染即可保留最新支持档位", async (t) => {
	const page = setup({ record: { ...existingSession(), thinkingLevel: "max" }, runtime: { agentId: "agent", runtimeGeneration: 7, status: "idle" }, models: [targetModel] });
	t.after(page.close);
	await page.current.applyThinking("high");
	await page.current.applyModel(targetModel);
	assert.deepEqual(
		[page.record.thinkingLevel, page.commands.map(([kind, , value]) => [kind, value])],
		[
			"high",
			[
				["thinking", "high"],
				["model", "target"],
			],
		],
	);
});

for (const storageUnavailable of [false, true]) {
	test(`欢迎页模型手选与创建快照一致（存储不可用=${storageUnavailable}）`, async (t) => {
		const page = setup({ storageUnavailable });
		t.after(page.close);
		await page.selectModel({ provider: "pi", id: "B", name: "Selected B" });
		const selected = page.store.get(page.welcomeModelAtom).pi;
		assert.deepEqual(JSON.parse(JSON.stringify(page.current.currentModel)), JSON.parse(JSON.stringify(selected)));
		assert.equal(selected.modelId, "B");
	});
}
