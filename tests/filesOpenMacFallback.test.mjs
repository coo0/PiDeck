import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { openPathWithFallback } = loadTsCommonJs("src/main/files/openPath.ts", {
	stubs: { "node:child_process": { spawn: () => ({ once: () => {} }) } },
});

const editor = { id: "vscode", name: "Visual Studio Code", command: "/usr/local/bin/code" };

/**
 * 回归（用户反馈）：macOS 上点击「打开会话文件」报 `Failed to open path`。
 * 会话文件是 .jsonl，LaunchServices 没有默认关联程序，`open` 返回
 * kLSApplicationNotFoundErr(-10814)，Electron 把这段系统错误文本原样返回。
 *
 * 期望的回退链：系统默认关联 → 用户已启用的外部编辑器 → macOS 文本编辑器。
 * 每一级失败才进入下一级，全部失败时抛最初的系统错误（保留诊断信息）。
 */

test("a successful shell.openPath never triggers any fallback", async () => {
	let editorCalls = 0;
	let textCalls = 0;
	await openPathWithFallback("/tmp/session.jsonl", {
		openPath: async () => "",
		platform: "darwin",
		listEditors: async () => [editor],
		openInEditor: async () => {
			editorCalls += 1;
		},
		openTextPath: async () => {
			textCalls += 1;
		},
	});
	assert.deepEqual([editorCalls, textCalls], [0, 0]);
});

test("macOS opens through the configured external editor when no app claims the file type", async () => {
	const opened = [];
	await openPathWithFallback("/tmp/session.jsonl", {
		openPath: async () => "Failed to open path",
		platform: "darwin",
		listEditors: async () => [editor],
		openInEditor: async (usedEditor, path) => {
			opened.push([usedEditor.id, path]);
		},
		openTextPath: async () => {
			throw new Error("the text editor must not be reached when an editor succeeded");
		},
	});
	assert.deepEqual(opened, [["vscode", "/tmp/session.jsonl"]]);
});

test("macOS falls back to the text editor when no external editor is enabled", async () => {
	const opened = [];
	await openPathWithFallback("/tmp/session.jsonl", {
		openPath: async () => "Failed to open path",
		platform: "darwin",
		listEditors: async () => [],
		openInEditor: async () => {
			throw new Error("no editor is configured");
		},
		openTextPath: async (path) => {
			opened.push(path);
		},
	});
	assert.deepEqual(opened, ["/tmp/session.jsonl"]);
});

test("macOS falls back to the text editor when launching the external editor fails", async () => {
	// 编辑器可能已被卸载/移动（detected 缓存仍在）：不能因此让「打开会话文件」彻底失败。
	const opened = [];
	await openPathWithFallback("/tmp/session.jsonl", {
		openPath: async () => "Failed to open path",
		platform: "darwin",
		listEditors: async () => [editor],
		openInEditor: async () => {
			throw new Error("spawn ENOENT");
		},
		openTextPath: async (path) => {
			opened.push(path);
		},
	});
	assert.deepEqual(opened, ["/tmp/session.jsonl"]);
});

test("macOS falls back to the text editor when listing editors throws", async () => {
	const opened = [];
	await openPathWithFallback("/tmp/session.jsonl", {
		openPath: async () => "Failed to open path",
		platform: "darwin",
		listEditors: async () => {
			throw new Error("settings unavailable");
		},
		openInEditor: async () => {
			throw new Error("must not be called");
		},
		openTextPath: async (path) => {
			opened.push(path);
		},
	});
	assert.deepEqual(opened, ["/tmp/session.jsonl"]);
});

test("non-darwin platforms surface the original shell.openPath error without extra fallbacks", async () => {
	await assert.rejects(
		() =>
			openPathWithFallback("/tmp/session.jsonl", {
				openPath: async () => "Failed to open path",
				platform: "win32",
				listEditors: async () => [editor],
				openInEditor: async () => {
					throw new Error("must not be used");
				},
				openTextPath: async () => {
					throw new Error("must not be used");
				},
			}),
		/Failed to open path/,
	);
});

test("the original system error is preserved when every fallback fails", async () => {
	// 不能让用户看到 `open -t exited with code 1` 这类实现细节：
	// 系统原始报错（含 kLSApplicationNotFoundErr 原因）才是可诊断的信息。
	await assert.rejects(
		() =>
			openPathWithFallback("/tmp/session.jsonl", {
				openPath: async () => "Failed to open path",
				platform: "darwin",
				listEditors: async () => [editor],
				openInEditor: async () => {
					throw new Error("spawn ENOENT");
				},
				openTextPath: async () => {
					throw new Error("open -t exited with code 1");
				},
			}),
		(error) => error.message === "Failed to open path",
	);
});
