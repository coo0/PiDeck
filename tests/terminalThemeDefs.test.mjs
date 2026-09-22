/**
 * 终端配色单一数据源契约（terminalThemes.ts）。
 *
 * 改动前配色有两份（TerminalDock.tsx 的 TERMINAL_THEMES + foundation.css 的
 * `[data-theme]` 变量块），必然漂移。这个测试守护合并后的三条边界：
 * 覆盖全部可选主题 id、每套主题 CSS 变量键完全一致、inherit 按明暗解析出不同结果。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { TERMINAL_THEME_DEFS, resolveTerminalTheme } = loadTsCommonJs("src/renderer/src/terminalThemes.ts");

/** 用户可选的终端主题 id（inherit 之外的联合成员，见 shared/types/settings.ts） */
const SELECTABLE_THEME_IDS = ["solarized-light", "solarized-dark", "one-dark", "monokai"];

test("theme defs cover every selectable terminal theme id exactly once", () => {
	const ids = [...TERMINAL_THEME_DEFS].map((def) => def.id);
	assert.deepEqual(ids.slice().sort(), SELECTABLE_THEME_IDS.slice().sort());
});

test("every theme def declares the same CSS variable keys in the same order", () => {
	const keyOrders = [...TERMINAL_THEME_DEFS].map((def) => Object.keys(def.css).join(","));
	for (const order of keyOrders) {
		assert.equal(order, keyOrders[0], "终端主题的 CSS 变量键集合/顺序必须一致，否则切主题会残留上一套变量");
	}
	assert.match(keyOrders[0], /^--terminal-bg/);
	assert.equal(keyOrders[0].split(",").length, 9);
});

test("resolveTerminalTheme derives distinct light/dark palettes for inherit", () => {
	const dark = resolveTerminalTheme("inherit", "dark");
	const light = resolveTerminalTheme("inherit", "light");
	assert.equal(dark.css["--terminal-bg"], "#15191d");
	assert.equal(light.css["--terminal-bg"], "#ffffff");
	assert.equal(dark.xterm.background, "#09090b");
	assert.equal(light.xterm.background, "#ffffff");
	// 暗色 inherit 在原 CSS 里额外带 box-shadow: none，转成变量后必须仍可识别
	assert.equal(dark.transparentShadow, true);
	assert.equal(light.transparentShadow, false);
});

test("resolveTerminalTheme returns the pinned palette for explicit theme ids", () => {
	const oneDark = resolveTerminalTheme("one-dark", "light");
	// 显式主题不随应用明暗变化（浅色应用下也是 One Dark）
	assert.equal(oneDark.xterm.background, "#282c34");
	assert.equal(resolveTerminalTheme("one-dark", "dark").xterm.background, "#282c34");
	assert.equal(oneDark.transparentShadow, false);
});

test("foundation.css no longer hardcodes terminal theme variable blocks", () => {
	const css = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	// 双份定义是本次修掉的缺陷：CSS 里不允许再出现按 data-theme 的 --terminal-bg 赋值
	assert.doesNotMatch(css, /\.terminal-dock\[data-theme="[^"]+"\]\s*\{[^}]*--terminal-bg/);
	assert.doesNotMatch(css, /:root\[data-theme="dark"\] \.terminal-dock/);
});
