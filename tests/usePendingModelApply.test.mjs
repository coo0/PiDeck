import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function setup(applyModel) {
	const effects = [];
	let cleared = 0;
	const notices = [];
	const sandbox = createTsSandbox({
		stubs: {
			react: { useRef: (current) => ({ current }), useEffect: (effect) => effects.push(effect) },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
		},
	});
	const { usePendingModelApply } = sandbox("src/renderer/src/hooks/usePendingModelApply.ts");
	usePendingModelApply({
		sessionId: "session",
		runtime: { agentId: "agent", runtimeGeneration: 9, status: "idle" },
		modelPending: { from: { provider: "p", modelId: "old" }, to: { provider: "p", modelId: "new", modelName: "New" } },
		applyModel,
		clearPending: () => {
			cleared++;
		},
		offerRestart: () => {},
	});
	const cleanups = effects.map((effect) => effect());
	return {
		get cleared() {
			return cleared;
		},
		notices,
		close: () => {
			for (const cleanup of cleanups) cleanup?.();
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("pending 空闲重试传递完整目标，等待模型和强度共同完成再清除", async (t) => {
	const gate = Promise.withResolvers();
	const calls = [];
	const state = setup(async (handle, model, isCurrent) => {
		calls.push([handle, model, isCurrent()]);
		await gate.promise;
		return true;
	});
	t.after(state.close);
	assert.equal(state.cleared, 0);
	gate.resolve();
	await flush();
	assert.deepEqual([JSON.parse(JSON.stringify(calls)), state.cleared], [[[{ sessionId: "session", agentId: "agent", runtimeGeneration: 9 }, { provider: "p", id: "new", name: "New" }, true]], 1]);
});

test("pending 卸载使异步应用失效，迟到成功不清除新状态", async () => {
	const gate = Promise.withResolvers();
	let isCurrent;
	const state = setup(async (_handle, _model, valid) => {
		isCurrent = valid;
		await gate.promise;
		return true;
	});
	state.close();
	gate.resolve();
	await flush();
	assert.deepEqual([isCurrent(), state.cleared], [false, 0]);
});

test("pending 运行时目标已失效时不清除待选值", async (t) => {
	const state = setup(async () => false);
	t.after(state.close);
	await flush();
	assert.equal(state.cleared, 0);
});
