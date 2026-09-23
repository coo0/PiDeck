/**
 * updateSources 更新源（GitHub 官方 + 镜像代理 + 自定义）纯函数单测。
 * 守护 URL 拼接、枚举归一化与自定义前缀校验规则；镜像清单与主进程 feedUrl
 * 生成共用一个 shared 源，此处同时验证两端入口一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 用 TypeScript transpileModule 加载 TS 源码（项目测试惯例，见 updateServiceE2E.test.mjs）。 */
function loadTsModule(filePath, deps) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (name) =>
				deps[name] ??
				(() => {
					throw new Error(`unexpected require: ${name}`);
				})(),
			console,
			URL, // vm 沙箱默认无 URL 全局，normalizeCustomMirrorHost 依赖它校验协议
		},
		{ filename: filePath },
	);
	return module.exports;
}

// shared/updateSources.ts 无 import，直接加载；main/update/updateSources.ts 依赖它。
const shared = loadTsModule("src/shared/updateSources.ts", {});
const mainModule = loadTsModule("src/main/update/updateSources.ts", {
	"../../shared/updateSources": shared,
	"../../shared/types/settings": { UpdateSourceId: undefined }, // 仅类型导入，运行时无碍
});

const { normalizeUpdateSource } = mainModule;
const { gitHubLatestDownloadBase, atomGitFeedUrl, atomGitLatestReleaseApiUrl, normalizeCustomMirrorHost, APP_UPDATE_REPO_OWNER, APP_UPDATE_REPO } = shared;

test("normalizeUpdateSource: 已知 id 原样保留", () => {
	assert.equal(normalizeUpdateSource("atomgit"), "atomgit");
	assert.equal(normalizeUpdateSource("github"), "github");
});

test("normalizeUpdateSource: 未知/非字符串回退 atomgit（默认首选）", () => {
	assert.equal(normalizeUpdateSource("ghfast"), "atomgit");
	assert.equal(normalizeUpdateSource("custom"), "atomgit");
	assert.equal(normalizeUpdateSource("hacked-source"), "atomgit");
	assert.equal(normalizeUpdateSource(undefined), "atomgit");
	assert.equal(normalizeUpdateSource(null), "atomgit");
	assert.equal(normalizeUpdateSource(42), "atomgit");
	assert.equal(normalizeUpdateSource(""), "atomgit");
});

// 本 fork：应用更新与内容更新坐标分离。内容源保持上游 ayuayue（fork 不重建内容资产），
// 应用源指向 coo0（fork 自己的 Release）。
test("content source keeps the upstream coordinates (ayuayue)", () => {
	assert.equal(atomGitFeedUrl(), "https://atomgit.com/ayuayue/PiDeck/releases/download/latest");
	assert.equal(gitHubLatestDownloadBase(), "https://github.com/ayuayue/PiDeck/releases/latest/download");
	assert.equal(atomGitLatestReleaseApiUrl(), "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest");
});

test("app update source points at the fork coordinates (coo0)", () => {
	assert.equal(APP_UPDATE_REPO_OWNER, "coo0");
	assert.equal(APP_UPDATE_REPO, "PiDeck");
});

test("normalizeCustomMirrorHost: trim/去尾斜杠/协议校验", () => {
	assert.equal(normalizeCustomMirrorHost("  https://a.com  "), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("https://a.com///"), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("https://a.com"), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("http://a.com"), "http://a.com");
	assert.equal(normalizeCustomMirrorHost("a.com"), null); // 缺协议
	assert.equal(normalizeCustomMirrorHost("ftp://a.com"), null); // 非 http(s)
	assert.equal(normalizeCustomMirrorHost(""), null);
	assert.equal(normalizeCustomMirrorHost("   "), null);
	assert.equal(normalizeCustomMirrorHost(null), null);
	assert.equal(normalizeCustomMirrorHost(undefined), null);
});
