import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归背景（2026-09 用户反馈）：轨迹抽屉上翻历史只挂了 `.finally`，没有 `.catch`。
 * 会话文件缺失时主进程 reject（`sessions:catalog-read-message-page` 抛 ENOENT），
 * 这个 promise 无人接管 → 渲染层冒成全局「未处理异常」弹窗，而抽屉里既看不出失败、
 * 也没有重试入口（按钮只是弹回）。同一个 hook 的两个翻页分支都要能吞掉并展示错误。
 *
 * 断言按「调用链」而不是整文件匹配：`void desktopApi.sessions.readRecordMessagePage(`
 * 之后的链式片段里必须出现 `.catch(`，否则即视为漏接错误。
 */
function readRendererSource(relativePath) {
	return readFileSync(relativePath, "utf8");
}

/**
 * 取出所有 `void desktopApi.sessions.readRecordMessagePage(` 调用链（到语句结束为止）。
 * 不能用 indexOf(";") 找结尾：`.then((page) => { ... return; ... })` 的箭头函数体里
 * 就有分号，会提前截断导致漏判。这里按括号深度扫到调用闭合，再往后吃到语句分号。
 */
function collectFloatingChains(source) {
	const chains = [];
	// 容忍空格/换行：`void` 与调用之间、以及 `.catch` 与 `(` 之间都可能换行。
	const start = /void\s+desktopApi\s*\.\s*sessions\s*\.\s*readRecordMessagePage\s*\(/g;
	for (const match of source.matchAll(start)) {
		// 从调用参数表开始，跨 `.then(...)` / `.catch(...)` / `.finally(...)` 一路扫，
		// 直到「所有括号都闭合后」遇到的第一个分号——那才是整条语句的结尾。
		let depth = 0;
		let end = source.length;
		for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
			const ch = source[i];
			if (ch === "(" || ch === "[" || ch === "{") depth += 1;
			else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
			else if (ch === ";" && depth === 0) {
				end = i;
				break;
			}
		}
		chains.push(source.slice(match.index, end));
	}
	return chains;
}

test("every floating readRecordMessagePage chain in the trajectory source has a catch", () => {
	const source = readRendererSource("src/renderer/src/hooks/useSessionTrajectorySource.ts");
	const chains = collectFloatingChains(source);
	assert.ok(chains.length >= 2, `expected at least 2 floating chains, found ${chains.length}`);
	for (const chain of chains) {
		assert.match(chain, /\.\s*catch\s*\(/, "floating readRecordMessagePage chain must attach .catch to avoid an unhandled rejection");
	}
});

test("the trajectory drawer surfaces a load-more failure instead of swallowing it", () => {
	const source = readRendererSource("src/renderer/src/hooks/useSessionTrajectorySource.ts");
	assert.match(source, /loadMoreError/);
	assert.match(source, /setLoadMoreError\s*\(/);
});

test("the trajectory view renders the load-more failure state", () => {
	const source = readRendererSource("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx");
	assert.match(source, /loadMoreError/);
	// 用户可见文案必须走 i18n，不得硬编码。
	assert.match(source, /t\(\s*"timeline\.loadMoreFailed"\s*\)/);
});
