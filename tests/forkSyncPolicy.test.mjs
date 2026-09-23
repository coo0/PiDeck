/**
 * fork 上游自动同步脚本（scripts/sync-upstream.mjs）的策略单测。
 *
 * 只测纯函数与「策略表 ↔ 文档一致」这两类可离线验证的事实：真实合并/推送行为
 * 由 fork-sync-upstream.yml 的 CI 运行验证（会真的合并并推送，不能在单测里跑）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONFLICT_POLICY, FORK_PACKAGE_FIELDS, PATCH_REPLAY_FILES, classifyConflict, mergePackageJson, parseSyncUpstreamArgs } from "../scripts/sync-upstream.mjs";

test("importing the sync script does not run the sync (no side effects)", () => {
	// 本测试能跑到这里本身就证明顶层没执行 main()：否则会真的 fetch/合并/推送。
	assert.equal(typeof classifyConflict, "function");
});

test("classifyConflict: fork 身份与自有能力取 ours", () => {
	assert.equal(classifyConflict("FORK.md"), "ours");
	assert.equal(classifyConflict("src/main/update/releaseRepo.ts"), "ours");
	assert.equal(classifyConflict("src/shared/updateSources.ts"), "ours");
	assert.equal(classifyConflict("resources/extensions/pi-deck-retry-no-body.ts"), "ours");
	assert.equal(classifyConflict("src/renderer/src/components/session/SessionContextMeter.tsx"), "ours");
});

test("classifyConflict: 上游所有取 theirs", () => {
	assert.equal(classifyConflict("src/main/pi/AgentManager.ts"), "theirs");
	assert.equal(classifyConflict("src/renderer/src/components/sidebar/Sidebar.tsx"), "theirs");
});

test("classifyConflict: 生成物走 regenerate，package.json 走字段级合并", () => {
	assert.equal(classifyConflict("resources/extensions/extensions-manifest.json"), "regenerate");
	assert.equal(classifyConflict("resources/pi-ai-catalog.json"), "regenerate");
	assert.equal(classifyConflict("announcements.json"), "regenerate");
	assert.equal(classifyConflict("package.json"), "package-json");
});

test("classifyConflict: package-lock.json 取上游（fork 不新增依赖）", () => {
	// fork 没有额外依赖：lock 由上游拥有，冲突时取上游而不是重新生成
	// （重新生成会保留 fork 的旧 lock 状态，与上游 deps 不一致）。
	assert.equal(classifyConflict("package-lock.json"), "theirs");
});

test("classifyConflict: 上游组装层带 fork 改动的文件走 patch（不得静默取上游）", () => {
	for (const file of PATCH_REPLAY_FILES) {
		assert.equal(classifyConflict(file), "patch", `${file} 必须走 patch 而不是 theirs`);
	}
	// 这两处历史冲突点恰好是 fork 真实功能所在，取 theirs 会丢功能
	assert.ok(PATCH_REPLAY_FILES.includes("src/renderer/src/App.tsx"));
	assert.ok(PATCH_REPLAY_FILES.includes("src/renderer/src/components/session/ComposerComponents.tsx"));
});

test("classifyConflict: 去掉 ./ 前缀后判定一致", () => {
	assert.equal(classifyConflict("./package.json"), "package-json");
	assert.equal(classifyConflict("./src/main/update/releaseRepo.ts"), "ours");
});

test("mergePackageJson: 保留 fork 的 publish/appId/repository，取上游的 version 与 scripts", () => {
	const ours = {
		version: "0.7.7-beta",
		scripts: { "sync:upstream": "node scripts/sync-upstream.mjs", test: "old-test" },
		build: { appId: "com.ayuayue.pi-desktop", publish: { provider: "github", owner: "coo0", repo: "PiDeck" } },
		repository: { url: "coo0" },
		homepage: "https://github.com/coo0/PiDeck",
	};
	const upstream = {
		version: "0.7.8",
		scripts: { test: "new-test", build: "new-build" },
		build: { appId: "com.ayuayue.pi-desktop", publish: { provider: "github", owner: "ayuayue", repo: "PiDeck" } },
		repository: { url: "ayuayue" },
		homepage: "https://github.com/ayuayue/PiDeck",
	};
	const merged = mergePackageJson(ours, upstream);

	assert.equal(merged.version, "0.7.8");
	assert.equal(merged.build.publish.owner, "coo0");
	assert.equal(merged.build.appId, "com.ayuayue.pi-desktop");
	assert.equal(merged.repository.url, "coo0");
	assert.equal(merged.homepage, "https://github.com/coo0/PiDeck");
	// scripts：上游为底（test/build 取上游），fork 独有键保留
	assert.equal(merged.scripts.test, "new-test");
	assert.equal(merged.scripts.build, "new-build");
	assert.equal(merged.scripts["sync:upstream"], "node scripts/sync-upstream.mjs");
});

test("mergePackageJson: 非对象入参抛错（避免把坏数据写回 package.json）", () => {
	assert.throws(() => mergePackageJson(null, {}), /two objects/);
	assert.throws(() => mergePackageJson({}, "nope"), /two objects/);
});

test("FORK_PACKAGE_FIELDS 覆盖发布坐标与应用身份", () => {
	const flat = FORK_PACKAGE_FIELDS.map((path) => path.join("."));
	assert.ok(flat.includes("build.publish.owner"));
	assert.ok(flat.includes("build.publish.repo"));
	assert.ok(flat.includes("build.appId"));
});

test("parseSyncUpstreamArgs: 默认推送并跑门禁，可用开关关闭", () => {
	assert.deepEqual(parseSyncUpstreamArgs([]), { dryRun: false, push: true, skipTests: false });
	assert.deepEqual(parseSyncUpstreamArgs(["--dry-run"]), { dryRun: true, push: true, skipTests: false });
	assert.deepEqual(parseSyncUpstreamArgs(["--no-push", "--skip-tests"]), { dryRun: false, push: false, skipTests: true });
});

test("策略表与 docs/fork-conflict-policy.md 不矛盾：A/C 区文件都在文档里出现", () => {
	const doc = readFileSync("docs/fork-conflict-policy.md", "utf8");
	for (const file of CONFLICT_POLICY.ours) {
		const basename = file.split("/").pop() ?? file;
		const dir = file.slice(0, file.lastIndexOf("/"));
		// 文档可用完整路径、basename，或目录通配（如 `src/main/terminal/*`）引用
		const mentioned = doc.includes(file) || doc.includes(basename) || (dir.length > 0 && doc.includes(`${dir}/*`));
		assert.ok(mentioned, `${file} 在策略表里但文档未提及`);
	}
});

test("补丁文件存在于 scripts/fork-patches（每个 patch 目标都有对应补丁）", () => {
	for (const file of PATCH_REPLAY_FILES) {
		const name = file.split("/").pop();
		const patchPath = `scripts/fork-patches/${name}.patch`;
		const content = readFileSync(patchPath, "utf8");
		assert.ok(content.includes(`a/${file}`), `${patchPath} 应对应 ${file}`);
	}
});
