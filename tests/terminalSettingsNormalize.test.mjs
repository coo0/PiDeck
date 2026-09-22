/**
 * 终端设置的脏数据回落（SettingsStore 的三个白名单解析器 + clampNumber）。
 *
 * 守护的边界：旧 settings.json 缺字段/未知枚举/越界数值都必须回落到可用值，
 * 否则 xterm 会拿到非法 scrollback/fontSize。
 */
import assert from "node:assert/strict";
import test from "node:test";

/**
 * 只取需要的纯函数：整模块导入会拉起 electron/日志等依赖，故用 loadTsCommonJs
 * 并注入 electron 桩（与同仓 tests/updateSourceMigration.test.mjs 的加载方式一致）。
 */
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { clampNumber, parseTerminalTheme, parseTerminalCursorStyle, parseTerminalConfirmClose } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
	stubs: {
		electron: { app: { getPath: () => "/tmp" }, BrowserWindow: class {}, Menu: { setApplicationMenu() {} } },
	},
});

test("unknown terminal theme falls back to inherit", () => {
	assert.equal(parseTerminalTheme("bogus"), "inherit");
	assert.equal(parseTerminalTheme(undefined), "inherit");
	assert.equal(parseTerminalTheme("monokai"), "monokai");
});

test("terminal cursor style and confirm mode fall back on dirty values", () => {
	assert.equal(parseTerminalCursorStyle("beam"), "block");
	assert.equal(parseTerminalCursorStyle("underline"), "underline");
	assert.equal(parseTerminalConfirmClose(undefined), "running");
	assert.equal(parseTerminalConfirmClose("always"), "always");
	assert.equal(parseTerminalConfirmClose("sometimes"), "running");
});

test("clampNumber rounds and clamps in-range values, falls back on non-numbers", () => {
	assert.equal(clampNumber(999_999, 0, 200_000, 5000), 200_000);
	assert.equal(clampNumber(-5, 0, 32, 8), 0);
	assert.equal(clampNumber(12.6, 0, 32, 8), 13);
	assert.equal(clampNumber("x", 0, 200_000, 5000), 5000);
	assert.equal(clampNumber(Number.NaN, 0, 200_000, 5000), 5000);
	assert.equal(clampNumber(undefined, 6, 32, 13), 13);
});
