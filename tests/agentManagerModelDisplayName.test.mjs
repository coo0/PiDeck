import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager(modelsConfig) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{
			getModelsConfig: async () => modelsConfig,
		},
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			client: {
				request: async ({ type }) => {
					if (type === "get_state") {
						return {
							success: true,
							data: {
								model: { provider: "router9", id: "qd/qfmodel", name: "runtime-raw-name" },
							},
						};
					}
					return { success: true, data: {} };
				},
			},
		},
	});
	return manager;
}

function modelsConfig(name) {
	return {
		parsed: {
			providers: {
				router9: {
					models: [{ id: "qd/qfmodel", name }],
				},
			},
		},
	};
}

test("getRuntimeState: models.json alias wins over pi runtime model.name", async () => {
	const manager = createManager(modelsConfig("qwen-3.8-flash"));

	const state = await manager.getRuntimeState("agent-1");

	assert.equal(state.provider, "router9");
	assert.equal(state.modelId, "qd/qfmodel");
	assert.equal(state.modelName, "qwen-3.8-flash");
});

test("getRuntimeState: blank configured name falls back to model id", async () => {
	const manager = createManager(modelsConfig("   "));

	const state = await manager.getRuntimeState("agent-1");

	assert.equal(state.modelName, "qd/qfmodel");
});

test("getRuntimeState: an unavailable models config falls back to model id", async () => {
	const manager = createManager({
		get parsed() {
			throw new Error("models config unavailable");
		},
	});

	const state = await manager.getRuntimeState("agent-1");

	assert.equal(state.modelName, "qd/qfmodel");
});
