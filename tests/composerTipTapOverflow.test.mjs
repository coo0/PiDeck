import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("TipTap composer keeps EditorContent inside a height-constrained overflow host", () => {
	// overflow-hidden 把滚动关进 ProseMirror；host 不能 min-h-0，否则正文无法把 shrink-0 输入卡撑开。
	assert.match(composer, /tiptap-composer-host[^"]*overflow-hidden/);
	assert.match(composer, /tiptap-composer-surface[^"]*overflow-hidden/);
});

test("TipTap ProseMirror grows with typed text then scrolls at the composer cap", () => {
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \{[\s\S]*?overflow:\s*hidden;/);
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \.tiptap-composer-surface \{[\s\S]*?overflow:\s*hidden;/);
	// host 与 surface 都必须允许 flex 子项收缩；终端打开后 composer 的 max-height
	// 才能把溢出滚动交给 ProseMirror，而不是裁掉编辑器底部。
	assert.match(timelineCss, /\.composer \.tiptap-composer-host,\s*\.composer \.tiptap-composer-host \.tiptap-composer-surface \{[\s\S]*?min-height:\s*0;/);
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \.ProseMirror,\s*\.composer \.tiptap-composer-host \.rich-input \{[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*var\(--composer-text-max-height,\s*336px\);[\s\S]*?overflow-y:\s*auto;/);
});

/**
 * 2026-09 回归：终端展开 + 长文本时输入卡底栏被挤出容器（被终端盖住）。
 * Playwright 实测（1100x620、终端展开、36 行输入）旧实现的几何：
 *   .session-v-composer 230→498，而 .composer-box 161→548（溢出 50px），
 *   .composer-bottom-bar 498→547 完全落在列外。
 * 根因是输入卡沿 flex 链路保留 min-height:auto 且 shrink-0，列被 max-height
 * 卡住时它不肯变矮 → 只能向列外溢出。
 */
test("terminal-open layout keeps the composer bar inside the column instead of overflowing", () => {
	const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");

	// 1) 列外框可被压缩（shrink 而非 shrink-0），否则列永远超出父级。
	assert.match(sessionView, /session-v-composer flex min-h-0 shrink flex-col overflow-hidden/);
	// 2) 输入卡本身是 flex 子项，必须允许收缩且不吃剩余高度（不写 flex-1/shrink-0）。
	assert.match(composerArea, /composer-box relative flex min-h-0 min-w-0 flex-col/);
	assert.doesNotMatch(composerArea, /composer-box relative flex[^"]*shrink-0/);
	assert.doesNotMatch(composerArea, /composer-box relative flex[^"]*flex-1/);
	// 3) 输入区变矮时必须能内部滚动（底栏是输入卡内的固定行，不参与滚动）。
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \.ProseMirror,\s*\.composer \.tiptap-composer-host \.rich-input \{[\s\S]*?overflow-y:\s*auto;/);
});
