/**
 * shell 可用性探测（TerminalSessionManager.isShellCommandAvailable + listShells）。
 *
 * 修掉的缺陷：listShells 曾对每个候选恒返回 available: true，与自己 JSDoc 的契约矛盾，
 * TerminalDock 里的置灰分支因此是死代码。判定必须只做存在性检查（不 spawn PTY）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isShellCommandAvailable } = loadTsCommonJs("src/main/terminal/TerminalSessionManager.ts", {
	stubs: { "node-pty": {} },
});

test("absolute paths are probed directly", () => {
	assert.equal(isShellCommandAvailable("/bin/sh"), true);
	assert.equal(isShellCommandAvailable("/definitely/not/a/shell"), false);
});

test("bare command names are resolved through PATH", () => {
	// node 自身一定在 PATH 上（测试进程就是它启动的）
	assert.equal(isShellCommandAvailable(process.platform === "win32" ? "node.exe" : "node"), true);
	assert.equal(isShellCommandAvailable("pideck-definitely-missing-shell"), false);
});
