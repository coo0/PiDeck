import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import test from "node:test";

const turnExecution = readFileSync("src/renderer/src/components/session/turn/useTurnExecution.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const appUiAtoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

test("non-live runs mount collapsed even without a final answer (interrupted rounds)", () => {
	// 只看历史/会话空闲（agentRunning=false）时一律初始折叠：无最终回答的中断轮
	// （stop/steer 打断，中间回答是其唯一输出）不再因设置①（流式展开）而在历史视图整段展开。
	assert.match(turnExecution, /if \(!opts\.agentRunning\) return false;/);
	// 初始折叠判定不再依赖 hasFinalAnswer（中断轮与完成轮在历史视图行为一致）
	const initializer = turnExecution.slice(turnExecution.indexOf("const [stepsVisible, setStepsVisible] = useState"), turnExecution.indexOf("});\n\tconst userOverrideRef"));
	assert.doesNotMatch(initializer, /opts\.hasFinalAnswer/);
});

test("interrupted rounds are still folded by the new-turn signal", () => {
	// 新一轮信号路径不受 hasFinalAnswer 门控：中断轮在新一轮开始时同样被强制收起。
	assert.match(turnExecution, /opts\.isLatestRun === false &&\s*currentTick > 0/);
	// 流式上升沿展开语义保留（仅设置①开启且非用户 override）
	assert.match(turnExecution, /!wasRunningRef\.current/);
});

test("queued prompt drains bump the new-turn collapse tick", () => {
	// 排队投递（steer「插入当前回合」/ followUp 排队）从 dispatchPromptSnapshot 出口提交，
	// 必须与普通发送一样 bump tick；否则重启后（tick=0）第一次排队发送永远不会
	// 触发「新一轮折叠」，上一轮（尤其被打断、无最终回答的轮）一直保持展开。
	const dispatchStart = app.indexOf("async function dispatchPromptSnapshot");
	assert.ok(dispatchStart > 0, "dispatchPromptSnapshot exists");
	const dispatch = app.slice(dispatchStart);
	const acceptedIndex = dispatch.indexOf("if (!result.accepted)");
	const bumpIndex = dispatch.indexOf("store.set(bumpNewTurnCollapseTickAtom, sessionId)");
	assert.ok(acceptedIndex > 0, "send fails fast on rejected prompt");
	assert.ok(bumpIndex > acceptedIndex, "tick bump happens only after accepted");
});

test("new-turn collapse is unconditional: the switch is gone from every layer", () => {
	// 开关已删除（用户要求恒定开启）：契约/默认值/UI/i18n 任何一层残留 key，
	// 都会让人以为还能关（或让旧 UI 读一个没人写的字段）。
	const layers = [
		["shared types", readFileSync("src/shared/types/settings.ts", "utf8")],
		["App 首屏默认值", app],
		["TurnFlowSettings", appUiAtoms],
		["useTurnExecution", turnExecution],
		["TurnRow", turnRow],
		["CommonTab", readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8")],
		["unsavedChangesSummary", readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8")],
		["settingsFieldAnchors", readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8")],
		["previewApi", readFileSync("src/renderer/src/previewApi.ts", "utf8")],
		["i18n zh-CN", readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8")],
		["i18n en-US", readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8")],
	];
	for (const [label, source] of layers) {
		assert.doesNotMatch(source, /collapsePrevRunsOnNewTurn/, `${label} 不应再引用已删除的开关`);
	}
	// SettingsStore 只保留迁移用的字面量（清理旧字段），默认值不得再出现。
	assert.doesNotMatch(settingsStore, /collapsePrevRunsOnNewTurn:\s*true/);
	// 行为无条件：初始态与 effect 都不再读开关。
	assert.doesNotMatch(turnExecution, /if \(!opts\.collapsePrevRunsOnNewTurn\) return;/);
});

// 迁移通过真实 load / 文件验证，避免把吞掉保存失败的实现锁进静态断言。
function makeMigrationStore(t, failWrite = false) {
	const root = mkdtempSync(join(tmpdir(), "pideck-collapse-setting-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let writes = 0;
	const failure = new Error("migration write failed");
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: { app: { getPath: () => root }, BrowserWindow: class {}, Menu: { setApplicationMenu() {} } },
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath() {} },
			"node:fs/promises": {
				...fsPromises,
				async writeFile(...args) {
					writes++;
					if (failWrite) throw failure;
					return fsPromises.writeFile(...args);
				},
			},
		},
	});
	writeFileSync(
		join(root, "settings.json"),
		JSON.stringify({
			installationType: process.env.PORTABLE_EXECUTABLE_DIR === undefined ? "installed" : "portable",
			chatContentWidthPct: 80,
			updateSourceAtomgitMigrated: true,
			collapsePrevRunsOnNewTurn: false,
			autoSessionTitle: true,
			webServiceHost: "127.0.0.1",
		}),
	);
	return { store: new SettingsStore(), root, failure, writes: () => writes };
}

test("SettingsStore 启动时清理旧开关字段并落盘一次", async (t) => {
	const { store, root, writes } = makeMigrationStore(t);
	await store.load();
	assert.equal("collapsePrevRunsOnNewTurn" in store.get(), false);
	const persisted = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
	assert.equal("collapsePrevRunsOnNewTurn" in persisted, false);
	assert.equal(persisted.autoSessionTitle, true);
	assert.equal(persisted.webServiceHost, "127.0.0.1");
	assert.equal(writes(), 1);
	await store.load();
	assert.equal(writes(), 1, "没有旧字段时不再写盘");
});

test("SettingsStore 旧开关迁移写盘失败时 load 拒绝", async (t) => {
	const { store, failure, writes } = makeMigrationStore(t, true);
	await assert.rejects(store.load(), (error) => error === failure);
	assert.equal(writes(), 1);
});

test("manual/streaming expansion is remembered across remounts (session-scoped)", () => {
	// 跨挂载记忆：手动/流式展开过的轮次切会话再切回恢复原样（2026 用户反馈：
	// 「运行的 Agent 里打开中间过程，跳到别的界面再回来发现思考被关闭」）。
	assert.match(sessionAtoms, /runStepsVisibleMemoryBySessionIdAtomFamily/);
	assert.match(sessionAtoms, /atomFamily\(\s*\(sessionId: string\) => atom<Record<string, RunStepsVisibleMemoryEntry>>\(\{\}\)/);
	// 记忆带 tick 版本：只有「写入晚于等于当前新一轮」的意愿恢复——新一轮之后
	// 用户再次手动展开必须可重新记住；早于最新一轮的旧记忆由新一轮规则压过。
	assert.match(turnExecution, /memory\.atTick >= currentTick/);
	// 新一轮已发生且本轮非最新时旧记忆作废（规则④优先）
	assert.match(turnExecution, /opts\.isLatestRun === false &&\s*currentTick > 0/);
	// 手动开合/流式展开写记忆（带 atTick）；新一轮折叠/自动收起清除记忆
	assert.match(turnExecution, /onStepsVisibleMemoryChange\?\./);
	// 新一轮折叠信号消费式处理：挂载即消费当前 tick（与 autoCollapseTick 同模式），
	// 否则恢复的记忆在 effect 首跑时就被再次清空
	assert.match(turnExecution, /lastNewTurnCollapseTickRef = useRef\(opts\.newTurnCollapseTick \?\? 0\)/);
	assert.match(turnExecution, /tick === lastNewTurnCollapseTickRef\.current/);
	// TurnRow 按 run.id 订阅记忆（selectAtom 隔离，不引发同会话整列重渲染）
	assert.match(turnRow, /runStepsVisibleMemoryBySessionIdAtomFamily/);
	assert.match(turnRow, /selectAtom/);
	assert.match(turnRow, /next\[runId\] = \{ visible, atTick \}/);
	// 会话删除时随其它 family 一起释放，避免 atomFamily 长期泄漏
	assert.match(sessionAtoms, /runStepsVisibleMemoryBySessionIdAtomFamily\.remove\(sessionId\)/);
	// 重挂载时把当前 autoCollapseTick 视为已消费：旧信号不得在恢复展开的瞬间再收起
	assert.match(turnExecution, /lastAutoCollapseTickRef = useRef\(opts\.autoCollapseTick \?\? 0\)/);
});
