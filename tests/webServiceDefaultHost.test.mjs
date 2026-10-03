import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 默认值三处来源 + manager 兜底均限本机；对外监听必须由用户显式指定。
const DEFAULT_HOST_SOURCES = ["src/main/settings/SettingsStore.ts", "src/renderer/src/App.tsx", "src/renderer/src/previewApi.ts"];

test("web service default host is loopback in every default-settings site", () => {
	for (const file of DEFAULT_HOST_SOURCES) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /webServiceHost:\s*"127\.0\.0\.1"/, `${file} must default webServiceHost to loopback`);
	}
	const managerSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
	assert.match(managerSource, /normalizeWebHost\(/, "manager must route host through normalizeWebHost");
});

test("WebServiceManager falls back to loopback when host setting is empty or whitespace", async () => {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch },
	});
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	// 先随机端口起一次拿可用端口，再走 applySettings 的空 host 兜底路径复用该端口。
	await manager.start("127.0.0.1", 0);
	const port = manager.current.port;
	try {
		for (const host of ["", "  ", "\t\n", "0.0.0.0", "127.0.0.1"]) {
			await manager.applySettings({
				webServiceEnabled: true,
				webServiceHost: host,
				webServicePort: port,
			});
			assert.equal(manager.current.host, host === "0.0.0.0" ? host : "127.0.0.1");
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Connection: "close" } });
			assert.equal(response.status, 200);
			assert.equal((await response.json()).host, manager.current.host);
		}
	} finally {
		await manager.stop();
	}
});

test("explicit custom and all-interface hosts remain unchanged", () => {
	const { normalizeWebHost } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	for (const host of ["0.0.0.0", "192.168.1.20", "localhost", "::1"]) {
		assert.equal(normalizeWebHost(`  ${host}  `), host);
	}
	assert.equal(normalizeWebHost("[::1]"), "::1");
});

test("binding failure does not retry on all interfaces", async () => {
	const attempts = [];
	const bindError = Object.assign(new Error("address unavailable"), { code: "EADDRNOTAVAIL" });
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch },
		stubs: {
			"node:http": {
				createServer: () => {
					let onError;
					return {
						on() {},
						once(_event, listener) {
							onError = listener;
						},
						listen(port, host) {
							attempts.push({ port, host });
							onError(bindError);
						},
					};
				},
			},
		},
	});
	const manager = new WebServiceManager({ subscribePiEvents: () => () => undefined });
	try {
		await assert.rejects(manager.applySettings({ webServiceEnabled: true, webServiceHost: "192.168.1.20", webServicePort: 8765 }), { code: "EADDRNOTAVAIL" });
		assert.deepEqual(attempts, [{ port: 8765, host: "192.168.1.20" }]);
		assert.equal(manager.getStatus().running, false);
	} finally {
		await manager.stop();
	}
});
