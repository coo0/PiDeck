import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 会话 Tab 栏右侧动作区布局契约：
 * 高频繁用的工具开关（草稿本 / 终端）常驻在「更多操作」左侧，不再要求用户
 * 先展开 ⋯ 菜单再点一次；低频 / 需要鼠标坐标定位弹层的动作（打开方式）
 * 保留在菜单内。
 */
const tabsBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

test("SessionToolAction 支持 inline 常驻标记", () => {
	assert.match(tabsBar, /export type SessionToolAction = \{[\s\S]*?inline\?: boolean;/);
});

test("inline 工具渲染成常驻图标按钮，且位于 ⋯ 触发器之前", () => {
	// 只渲染 inline 的开关，并带无障碍标记（title/aria-label/aria-pressed）
	const inlineBlock = tabsBar.match(/\{props\.toolActions\s*\n?\s*\?\.filter\(\(action\) => action\.inline\)[\s\S]*?\)\)\}/)?.[0] ?? "";
	assert.ok(inlineBlock.length > 0, "Tab 栏应渲染 inline 工具按钮");
	assert.match(inlineBlock, /aria-label=\{action\.label\}/);
	assert.match(inlineBlock, /title=\{action\.label\}/);
	assert.match(inlineBlock, /aria-pressed=\{action\.active === true\}/);
	assert.match(inlineBlock, /session-tabs-tool-inline/);

	// DOM 顺序：常驻图标块必须在 DropdownMenu（⋯）之前
	const inlineIndex = tabsBar.indexOf("session-tabs-tool-inline");
	const menuIndex = tabsBar.indexOf("<DropdownMenu>", tabsBar.indexOf("session-tabs-actions"));
	assert.ok(inlineIndex !== -1 && menuIndex !== -1);
	assert.ok(inlineIndex < menuIndex, "常驻工具图标必须排在「更多操作」左侧");
});

test("菜单里只保留非 inline 工具，不出现重复入口", () => {
	assert.match(tabsBar, /props\.toolActions\.some\(\(action\) => !action\.inline\)/);
	assert.match(tabsBar, /props\.toolActions\s*\n?\s*\.filter\(\(action\) => !action\.inline\)/);
	// 不再无条件 map 整个 toolActions（否则常驻项会在菜单里又出现一次）
	assert.doesNotMatch(tabsBar, /props\.toolActions\.map\(/);
});

test("⋯ 触发器的高亮只看菜单内动作的激活态", () => {
	assert.match(tabsBar, /props\.toolActions\?\.some\(\(action\) => !action\.inline && action\.active\)/);
});

test("草稿本与终端标记为常驻，打开方式留在菜单", () => {
	// 草稿本
	assert.match(app, /id: "scratch",[\s\S]{0,200}?inline: true,/);
	// 终端
	assert.match(app, /id: "terminal",[\s\S]{0,200}?inline: true,/);
	// 打开方式依赖 event.currentTarget 坐标定位弹层，不适合常驻按钮复用同一处理器，
	// 因此不做 inline 标记。
	const editorsBlock = app.slice(app.indexOf('id: "editors"'), app.indexOf('id: "editors"') + 400);
	assert.doesNotMatch(editorsBlock, /inline: true/);
	assert.match(editorsBlock, /adjustMenuPos/);
});
