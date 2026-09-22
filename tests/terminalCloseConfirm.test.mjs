/**
 * 终端关闭确认判定（terminalDockState.shouldConfirmTerminalClose）。
 *
 * 判定依据是 node-pty 上报的前台进程名，而不同 shell/平台格式不一
 * （可能带 .exe、可能是完整路径），所以这里把宽松策略的边界钉住：
 * 宁可漏弹（不打断）也不要在空闲提示符上误弹。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTerminalDockState() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/terminalDockState.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "terminalDockState.ts" });
	return sandbox.exports;
}

const { shouldConfirmTerminalClose } = loadTerminalDockState();

test("never mode never asks, regardless of front process", () => {
	assert.equal(shouldConfirmTerminalClose("never", "sleep", "zsh"), false);
	assert.equal(shouldConfirmTerminalClose("never", undefined, "zsh"), false);
});

test("always mode always asks, even at an idle prompt", () => {
	assert.equal(shouldConfirmTerminalClose("always", "zsh", "zsh"), true);
	assert.equal(shouldConfirmTerminalClose("always", undefined, "zsh"), true);
});

test("running mode skips the prompt when the front process is the shell itself", () => {
	assert.equal(shouldConfirmTerminalClose("running", "zsh", "zsh"), false);
	// 带路径与大小写差异的上报同样视为空闲（basename + 小写比较）
	assert.equal(shouldConfirmTerminalClose("running", "/bin/zsh", "zsh"), false);
	assert.equal(shouldConfirmTerminalClose("running", "C:\\Windows\\System32\\cmd.exe", "cmd"), false);
});

test("running mode asks when a non-shell foreground process is reported", () => {
	assert.equal(shouldConfirmTerminalClose("running", "sleep", "zsh"), true);
	assert.equal(shouldConfirmTerminalClose("running", "node", "bash"), true);
});

test("running mode does not ask when the front process is unknown", () => {
	// 拿不到证据就不拦：process 恒空的平台上宁可漏弹
	assert.equal(shouldConfirmTerminalClose("running", undefined, "zsh"), false);
	assert.equal(shouldConfirmTerminalClose("running", "   ", "zsh"), false);
});

test("git-bash reports bash as its idle process name", () => {
	assert.equal(shouldConfirmTerminalClose("running", "bash.exe", "git-bash"), false);
	assert.equal(shouldConfirmTerminalClose("running", "npm", "git-bash"), true);
});
