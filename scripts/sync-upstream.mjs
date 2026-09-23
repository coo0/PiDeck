#!/usr/bin/env node
/**
 * 自动同步上游（`upstream/main`）到 `custom`，按 `docs/fork-conflict-policy.md` 解冲突。
 *
 * 为什么用临时 worktree：合并需要切到 custom，而工作区经常有别的任务在编辑的文件；
 * worktree 让整个合并发生在系统临时目录，当前分支与工作区完全不受影响。
 *
 * 流程：fetch upstream → 建临时 worktree(custom) → merge upstream/main
 *   → 冲突按策略解决（见 CONFLICT_POLICY）→ 重新生成生成物
 *   → typecheck + 全量测试门禁 → 推送 origin custom
 *
 * 安全约定（与 AGENTS.md 一致）：
 * - **禁止** `-X ours/theirs` 静默吞改动；取边必须是策略表里的显式决定；
 * - 策略表未覆盖的冲突 → 不推送，写冲突报告（CI 据此开 issue）；
 * - 不改写历史、不 force push；
 * - 任何失败路径都清理临时 worktree（catch + finally）；
 * - **只在「本文件就是入口」时执行**：纯函数供单测 import，否则单测会真的合并并推送。
 *
 * 用法：
 *   npm run sync:upstream                    # 合并 + 校验 + 推送
 *   npm run sync:upstream -- --dry-run       # 只预览会并入什么
 *   npm run sync:upstream -- --no-push       # 合并 + 校验，不推送（本地验证用）
 *   npm run sync:upstream -- --skip-tests    # 跳过测试门禁（仅调试；CI 禁用）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_BRANCH = "upstream/main";
const TARGET_BRANCH = "custom";
const ORIGIN_REMOTE = "origin";

/** 冲突报告输出路径（CI 读取后开 issue；--no-push 时供人工查看）。 */
export const CONFLICT_REPORT_PATH = "fork-sync-conflict-report.json";

/** fetch upstream 的超时（ms）：离线时不能无限挂住 CI job。 */
const FETCH_TIMEOUT_MS = 120_000;

/** fork 补丁目录：上游所有的文件里承载 fork 改动时，用这里的补丁重放。 */
export const PATCH_DIR = "scripts/fork-patches";

/**
 * 补丁重放名单：这些文件**属于上游**（上游会持续重构），但 fork 在其中加了真实功能。
 * 冲突时：取上游版本 → `git apply --3way` 重放 fork 补丁。
 * 补丁每次同步成功后自动从 `upstream/main..HEAD` 重新生成，所以会跟着上游演进。
 */
export const PATCH_REPLAY_FILES = ["src/renderer/src/App.tsx", "src/renderer/src/components/session/ComposerComponents.tsx"];

/** 受控中止：由 main 捕获后统一收尾，保证临时 worktree 一定被清理。 */
class SyncAbort extends Error {}

/**
 * 冲突分区策略 —— **运行时唯一依据**（`docs/fork-conflict-policy.md` 是它的说明文档）。
 *
 * 取值：
 * - `ours`：取 fork（custom）版本 —— fork 身份文件与自有能力；
 * - `theirs`：取上游版本 —— 上游所有的普通文件；
 * - `regenerate`：取上游后重新生成 —— 生成物，禁止手工解；
 * - `package-json`：字段级特例 —— 保留 fork 的 publish/appId/repository，其余取上游。
 */
export const CONFLICT_POLICY = {
	ours: [
		// A 区：fork 身份与坐标
		"FORK.md",
		"docs/fork-conflict-policy.md",
		".githooks/pre-push",
		"src/main/update/releaseRepo.ts",
		"src/shared/updateSources.ts",
		// C 区：fork 自有能力（终端 GPU 渲染 + 终端设置页）
		"resources/extensions/pi-deck-retry-no-body.ts",
		"src/main/config/userUsageProbes.ts",
		"src/renderer/src/config/UsageProbeConfigDialog.tsx",
		"src/main/terminal/TerminalSessionManager.ts",
		"src/renderer/src/terminalThemes.ts",
		"src/renderer/src/terminalDockState.ts",
		"src/shared/types/terminal.ts",
		"src/renderer/src/components/app/settings/TerminalTab.tsx",
		"src/renderer/src/components/app/settings/settingsTabLayout.ts",
		"src/renderer/src/utils/settingsFieldAnchors.ts",
		// C 区：底栏模型档位控件 + 上下文圆环
		"src/renderer/src/components/session/ModelEffortPopover.tsx",
		"src/renderer/src/components/session/EffortSlider.tsx",
		"src/renderer/src/components/session/ModelPickerBody.tsx",
		"src/renderer/src/components/session/SessionContextMeter.tsx",
		"src/renderer/src/utils/effortColors.ts",
		"src/renderer/src/utils/effortSlider.ts",
		"src/renderer/src/utils/modelEffortPopover.ts",
		"src/renderer/src/utils/contextSpend.ts",
		"src/renderer/src/hooks/useContextSpendEffects.ts",
	],
	regenerate: ["resources/extensions/extensions-manifest.json", "resources/pi-ai-catalog.json", "resources/pi-ai-catalog.manifest.json", "resources/prompts/prompts-manifest.json", "resources/skills/skills-manifest.json", "announcements.json"],
	packageJson: ["package.json"],
};

/** 重新生成生成物的命令（按序执行；失败即同步失败）。 */
export const REGENERATE_COMMANDS = [
	["node", "scripts/generate-pi-ai-catalog.mjs"],
	["node", "scripts/generate-extensions-manifest.mjs"],
	["node", "scripts/generate-content-manifests.mjs", "--domain", "prompts"],
	["node", "scripts/generate-content-manifests.mjs", "--domain", "skills"],
	["node", "scripts/build-announcements.js"],
];

/** package.json 中属于 fork 身份、必须保留的字段路径（点分）。 */
export const FORK_PACKAGE_FIELDS = [["build", "publish", "owner"], ["build", "publish", "repo"], ["build", "appId"], ["repository"], ["homepage"], ["bugs"]];

/** 解析参数（纯函数，便于单测）。 */
export function parseSyncUpstreamArgs(argv) {
	const options = { dryRun: false, push: true, skipTests: false };
	for (const arg of argv) {
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--no-push") options.push = false;
		else if (arg === "--skip-tests") options.skipTests = true;
	}
	return options;
}

/** 判断冲突文件的处置方式（纯函数）。 */
/**
 * 判断冲突文件的处置方式（纯函数）。
 *
 * ## 为什么默认是 `ours`（custom 优先）而不是 `theirs`
 *
 * git 的语义保证：**只有双方都改了同一处才会产生冲突**。若只有上游改了某文件，
 * git 会直接采用上游；若只有 custom 改了，git 会直接保留 custom。因此**每一个冲突
 * 文件都必然包含 custom 的改动**——此时取上游（theirs）等于静默删掉 custom 的功能，
 * 正是 AGENTS.md 明禁的失败模式，也与「custom 新增功能与 bug 修复优先」的原则相悖。
 *
 * 所以默认取 custom（ours），并把「上游对该文件的改动被放弃」明确记入摘要，
 * 由 typecheck + 全量测试门禁把关，让人有机会复核。宁可噪声大，不可静默丢改动。
 *
 * 特例（优先于默认）：
 * - `package-json`：字段级合并（保留 custom 身份字段 + 上游其余）
 * - `regenerate`：生成物取上游后重新生成（生成器会读 custom 的源文件，不会丢 custom 内容）
 * - `patch`：上游重度重构的组装层 → 取上游 + 重放 custom 补丁（双方都保留，优于整文件取边）
 */
export function classifyConflict(filePath) {
	const normalized = filePath.replace(/^\.\//, "");
	if (CONFLICT_POLICY.packageJson.includes(normalized)) return "package-json";
	if (CONFLICT_POLICY.regenerate.includes(normalized)) return "regenerate";
	// patch 重放优先于 ours：这些文件上游会持续重构，整文件取 custom 会连带回退
	// 上游的重构（可能破坏其它依赖它的代码）；重放补丁能在上游基础上保住 custom 的改动。
	if (PATCH_REPLAY_FILES.includes(normalized)) return "patch";
	if (CONFLICT_POLICY.ours.includes(normalized)) return "ours";
	// 默认 custom 优先：冲突必然意味着这里有 custom 的改动，不能丢。
	return "ours";
}

/**
 * 合并 fork 身份字段：以 `upstream` 的 package.json 为基础，回填 `ours` 的 fork 字段。
 *
 * `scripts` 是混合区：上游新增/修改的脚本要跟上游，但 fork 新增的脚本
 * （如 `sync:upstream`）不能丢。因此对 `scripts` 做「上游为底 + 补 fork 独有键」的合并，
 * 而不是整块取 upstream。
 *
 * 纯函数（不碰文件系统），便于单测。
 */
export function mergePackageJson(ours, upstream) {
	if (!isRecord(ours) || !isRecord(upstream)) {
		throw new Error("package.json merge requires two objects");
	}
	const merged = structuredClone(upstream);
	for (const path of FORK_PACKAGE_FIELDS) {
		const value = readPath(ours, path);
		if (value === undefined) continue;
		writePath(merged, path, value);
	}
	// scripts：上游为底，补回 fork 独有的键（fork 对上游同名脚本的改动不保留——那些改动应上游化）
	const ourScripts = readPath(ours, ["scripts"]);
	const mergedScripts = readPath(merged, ["scripts"]);
	if (isRecord(ourScripts)) {
		const target = isRecord(mergedScripts) ? mergedScripts : {};
		for (const [key, value] of Object.entries(ourScripts)) {
			if (!(key in target)) target[key] = value;
		}
		writePath(merged, ["scripts"], target);
	}
	return merged;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(root, path) {
	let current = root;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function writePath(root, path, value) {
	let current = root;
	for (const key of path.slice(0, -1)) {
		const next = current[key];
		if (!isRecord(next)) {
			const created = {};
			current[key] = created;
			current = created;
		} else {
			current = next;
		}
	}
	const last = path[path.length - 1];
	if (last) current[last] = value;
}

function log(message) {
	process.stdout.write(`${message}\n`);
}

function warn(message) {
	process.stderr.write(`${message}\n`);
}

/** 运行 git；返回 { ok, stdout, stderr }。cwd 用于在临时 worktree 内执行。 */
function git(args, cwd, timeoutMs) {
	const result = spawnSync("git", args, { encoding: "utf8", cwd, timeout: timeoutMs });
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** 运行命令（非 git，如 npm / node 脚本）。 */
function run(command, cwd) {
	const [bin, ...args] = command;
	if (!bin) return { ok: false, output: "empty command" };
	const result = spawnSync(bin, args, { encoding: "utf8", cwd, stdio: "pipe" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { ok: result.status === 0, output };
}

function firstLine(text) {
	return text.split("\n")[0] ?? "";
}

function short(sha) {
	return sha ? sha.slice(0, 8) : "(无)";
}

function conflictingFiles(cwd) {
	const result = git(["diff", "--name-only", "--diff-filter=U"], cwd);
	return result.ok && result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
}

/**
 * 按策略解决冲突文件。
 * 返回无法自动解决的文件（策略未覆盖 / 取边失败），由调用方决定是否中止。
 */
function resolveConflicts(worktree, files) {
	const unresolved = [];
	const resolved = [];
	for (const file of files) {
		const how = classifyConflict(file);
		if (how === "ours") {
			const result = git(["checkout", "--ours", "--", file], worktree);
			if (!result.ok) {
				unresolved.push(file);
				continue;
			}
			git(["add", "--", file], worktree);
			resolved.push({ file, how: "ours (fork 身份/自有能力)" });
		} else if (how === "theirs") {
			const result = git(["checkout", "--theirs", "--", file], worktree);
			if (!result.ok) {
				unresolved.push(file);
				continue;
			}
			git(["add", "--", file], worktree);
			resolved.push({ file, how: "theirs (上游所有)" });
		} else if (how === "regenerate") {
			// 取上游版本占位，稍后由 REGENERATE_COMMANDS 重新生成
			git(["checkout", "--theirs", "--", file], worktree);
			git(["add", "--", file], worktree);
			resolved.push({ file, how: "regenerate (取上游后重新生成)" });
		} else if (how === "patch") {
			// 取上游版本，再把 fork 补丁重放上去。
			// --3way 需要 index 里有该 blob，所以必须先 add 再 apply。
			const taken = git(["checkout", "--theirs", "--", file], worktree);
			if (!taken.ok) {
				unresolved.push(file);
				continue;
			}
			git(["add", "--", file], worktree);
			const patchPath = join(PATCH_DIR, `${basename(file)}.patch`);
			if (!existsSync(join(worktree, patchPath))) {
				// 缺补丁文件：不能默默取上游，否则丢功能 → 交人工
				unresolved.push(`${file}（缺少 ${patchPath}）`);
				continue;
			}
			const applied = git(["apply", "--3way", patchPath], worktree);
			let howText = "patch (取上游 + 重放补丁)";
			if (!applied.ok) {
				// 3way 留下了冲突块。历史冲突形态是「双方各自新增相邻内容」
				// （上游加 atom、fork 加 atom），用可证明安全的并集规则解；
				// 解不了（非 import/非纯新增）就中止，不产出可疑代码。
				if (!applyUnionResolution(worktree, file)) {
					unresolved.push(file);
					continue;
				}
				howText = "patch (取上游 + 重放补丁 + 并集解冲突)";
			}
			// 无论 apply 退出码如何，都不允许把带冲突标记的文件交出去
			if (readFileSync(join(worktree, file), "utf8").includes("<<<<<<<")) {
				unresolved.push(file);
				continue;
			}
			git(["add", "--", file], worktree);
			resolved.push({ file, how: howText });
		} else if (how === "package-json") {
			const oursRaw = git(["show", `:2:${file}`], worktree);
			const theirsRaw = git(["show", `:3:${file}`], worktree);
			if (!oursRaw.ok || !theirsRaw.ok) {
				unresolved.push(file);
				continue;
			}
			try {
				const merged = mergePackageJson(JSON.parse(oursRaw.stdout), JSON.parse(theirsRaw.stdout));
				writeFileSync(join(worktree, file), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
				git(["add", "--", file], worktree);
				resolved.push({ file, how: "package-json (保留 fork 身份字段 + 上游其余)" });
			} catch {
				unresolved.push(file);
			}
		}
	}
	return { unresolved, resolved };
}

/**
 * 取上游侧（stage 3）与该文件 merge-base 的差异，即「若取 custom 会放弃的上游改动」。
 * 用于复核：尤其确认上游没有修掉同一个 bug。取不到时返回空串。
 */
function upstreamSideDiff(worktree, file) {
	const theirs = git(["show", `:3:${file}`], worktree);
	if (!theirs.ok) return "";
	// 用 diff 对比 stage3 与 stage1（base）不好做（base 不总是存在），
	// 直接给上游版本的局部上下文更有用：列出上游侧冲突块附近的代码。
	return theirs.stdout.slice(0, 4000);
}

function writeConflictReport(payload) {
	try {
		writeFileSync(CONFLICT_REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch {
		// 报告写不出来不应掩盖真正的失败原因
	}
}

/**
 * 把冲突块解为「双方改动的并集」（保留顺序、去重）。
 *
 * 为什么只对补丁重放文件用：这些文件的冲突形态是「上游与 fork 各自新增相邻内容」
 * （如两边各向同一 import 语句加一个 atom），取任一边都会丢功能，并集才是正确解。
 * 并集结果仍需通过 typecheck + 全量测试门禁：并集错了就红，不会静默发出。
 *
 * 返回 false 表示标记结构异常（嵌套/缺结束标记），交调用方转人工。
 */
/**
 * 对 worktree 里的文件套用并集解冲突（逐个冲突块调 resolveConflictUnion）。
 * 任一块解不了 → 返回 false（文件保持原样，由调用方转人工）。
 */
function applyUnionResolution(worktree, file) {
	const full = join(worktree, file);
	const lines = readFileSync(full, "utf8").split("\n");
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith("<<<<<<<")) {
			out.push(line);
			i += 1;
			continue;
		}
		const ours = [];
		const theirs = [];
		const base = [];
		let section = "ours";
		let closed = false;
		i += 1;
		for (; i < lines.length; i += 1) {
			const current = lines[i];
			if (current.startsWith("|||||||")) {
				section = "base";
				continue;
			}
			if (current.startsWith("=======")) {
				section = "theirs";
				continue;
			}
			if (current.startsWith(">>>>>>>")) {
				closed = true;
				break;
			}
			if (section === "ours") ours.push(current);
			else if (section === "theirs") theirs.push(current);
			else base.push(current);
		}
		if (!closed) return false;
		const merged = resolveConflictUnion(ours.join("\n"), theirs.join("\n"), base.join("\n"));
		if (merged === null) return false;
		out.push(merged);
		i += 1;
	}
	writeFileSync(full, out.join("\n"), "utf8");
	return true;
}

/**
 *
 * 为什么不能简单按行并集：冲突块常是「上游与 fork 各自新增相邻内容」，但两侧的
 * 块边界并不对齐——例如上游新增
 *     const setHiddenModules = useSetAtom(hiddenModulesAtom);
 *     useEffect(() => { ... }, [...]);
 * 而 fork 新增
 *     const setContextSpendAnimation = useSetAtom(...);
 *     useEffect(() => { ... }, [...]);
 * 按行去重并集会把两个 useEffect 的**结构行**揉在一起（`useEffect(() => {` 被当成
 * 重复行只保留一次），产出语法错误的代码。因此只接受两类可证明安全的形态，
 * 其余一律返回 false 交人工：
 *   1. 两侧都是 import 语句 → 合并成一条 import（取 specifier 并集）；
 *   2. 一侧的每一行都出现在另一侧 → 纯新增，取行数多的那侧（不重复拼接）。
 * 任何无法归入上述两类的块，宁可中止也不产出可疑代码。
 *
 * 返回 false 表示无法安全自动解决（调用方转人工，不推送）。
 */
export function resolveConflictUnion(oursText, theirsText, baseText = "") {
	const ours = splitLines(oursText);
	const theirs = splitLines(theirsText);
	const base = splitLines(baseText);
	if (ours.length === 0) return theirsText;
	if (theirs.length === 0) return oursText;

	// 规则 1：整个冲突块都是 import 语句 → 按模块合并（specifier 取并集）。
	// 为什么安全：import 的**超集**永远是合法 TS（本仓库 noUnusedLocals=false，
	// 未使用的 import 不报错），而同模块的多条 import 也合法。两侧各自向 import
	// 区新增符号时，并集正是正确解。
	const mergedImports = mergeImportBlocks(ours, theirs);
	if (mergedImports !== null) return mergedImports;

	// 规则 2：add/add（base 为空）→ 两侧都是在同一位置新增的独立内容，保留双方。
	// 这是 git add/add 冲突的标准解法；顺序取 ours 在前。
	// 必须整块拼接，不能按行去重——两侧的结构行（如 `useEffect(() => {`）相同但
	// 各自成对，去重会把两个块揉坏（曾产出语法错误，由 typecheck 门禁拦下）。
	if (base.length === 0) {
		return [...ours, ...theirs].join("\n");
	}

	// 规则 3：一侧是另一侧的超集 → 纯新增，取超集。
	if (isSubsetOf(ours, theirs)) return theirsText;
	if (isSubsetOf(theirs, ours)) return oursText;

	// 其余（双方真的改了同一处，如函数体语义不同）→ 交人工，绝不猜。
	return null;
}

/**
 * 若两侧的每一行都是具名 import，按模块合并成一组 import 行（specifier 并集）。
 * 顺序：ours 里出现的模块顺序优先，再补 theirs 独有的模块。
 * 任一行不是具名 import → 返回 null（不适用本规则）。
 */
function mergeImportBlocks(ours, theirs) {
	const oursParsed = parseImportLines(ours);
	const theirsParsed = parseImportLines(theirs);
	if (!oursParsed || !theirsParsed) return null;

	const order = [];
	const byModule = new Map();
	for (const parsed of [...oursParsed, ...theirsParsed]) {
		if (!byModule.has(parsed.module)) {
			byModule.set(parsed.module, new Set());
			order.push(parsed.module);
		}
		const specifiers = byModule.get(parsed.module);
		for (const specifier of parsed.specifiers) specifiers.add(specifier);
	}
	return order.map((module) => `import { ${[...byModule.get(module)].join(", ")} } from "${module}";`).join("\n");
}

/** 解析「全为具名 import 行」的块；任一行不是该形态返回 null。 */
function parseImportLines(lines) {
	const parsed = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		const match = line.match(/^import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?$/);
		if (!match) return null;
		const specifiers = match[1]
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
		parsed.push({ specifiers, module: match[3] });
	}
	return parsed.length > 0 ? parsed : null;
}

/** 拆行并去掉末尾空行（git 冲突块内容不含首尾换行）。 */
function splitLines(text) {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * 解析「单行具名 import」：`import { a, b } from "mod";`
 * 不是这种形态（多行 import / default import / 副作用 import）返回 null。
 */

/** lines 的每一行是否都能在 haystack 中找到（多重集包含）。 */
function isSubsetOf(lines, haystack) {
	const counts = new Map();
	for (const line of haystack) counts.set(line, (counts.get(line) ?? 0) + 1);
	for (const line of lines) {
		const remaining = counts.get(line) ?? 0;
		if (remaining === 0) return false;
		counts.set(line, remaining - 1);
	}
	return true;
}

function main() {
	const options = parseSyncUpstreamArgs(process.argv.slice(2));

	if (!git(["rev-parse", "--verify", "--quiet", `refs/remotes/${UPSTREAM_BRANCH}`]).ok) {
		warn(`找不到 ${UPSTREAM_BRANCH}。先执行：git remote add upstream https://github.com/ayuayue/PiDeck.git && git fetch upstream`);
		process.exitCode = 1;
		return;
	}
	if (!git(["rev-parse", "--verify", "--quiet", `refs/heads/${TARGET_BRANCH}`]).ok) {
		warn(`本地没有 ${TARGET_BRANCH} 分支。`);
		process.exitCode = 1;
		return;
	}

	// rerere：把解过的冲突记下来，后续同冲突自动重放（自动同步能收敛的前提）
	git(["config", "rerere.enabled", "true"]);
	git(["config", "rerere.autoupdate", "true"]);

	// fetch 加超时：无网络环境（本地离线、GitHub 抽风）不能让脚本无限挂住，
	// 否则 CI job 会被 6 小时上限强杀。失败仍继续用本地已有引用（下方有告警）。
	const fetched = git(["fetch", UPSTREAM_REMOTE, "--tags"], undefined, FETCH_TIMEOUT_MS);
	if (!fetched.ok) warn(`⚠️  git fetch ${UPSTREAM_REMOTE} 失败（${FETCH_TIMEOUT_MS / 1000}s 超时或网络错误），改用本地已有引用：${firstLine(fetched.stderr)}`);

	const incoming = git(["log", "--no-merges", "--oneline", `${TARGET_BRANCH}..${UPSTREAM_BRANCH}`]);
	const incomingCount = incoming.stdout ? incoming.stdout.split("\n").filter(Boolean).length : 0;
	log(`📋 同步 ${UPSTREAM_BRANCH} → ${TARGET_BRANCH}（待并入 ${incomingCount} 个提交）`);

	if (options.dryRun) {
		log("");
		log("🧪 dry-run：不建 worktree、不合并、不推送。");
		return;
	}

	let worktree = "";
	try {
		worktree = mkdtempSync(join(tmpdir(), "pideck-fork-sync-"));
		rmSync(worktree, { recursive: true, force: true });
		// 用 --detach：目标分支可能正被当前工作区检出（本地在 custom 上跑，或 CI 的
		// actions/checkout 检出 custom），此时 `worktree add <dir> custom` 会被拒绝。
		// 推送用显式 `HEAD:custom`，因此 worktree 里不需要分支名。
		const added = git(["worktree", "add", "--detach", worktree, TARGET_BRANCH]);
		if (!added.ok) throw new SyncAbort(`无法创建临时 worktree：${firstLine(added.stderr)}`);

		// 待推送提交数。必须先确认远端引用存在：origin/custom 解析失败时 rev-list 会静默
		// 返回空，ahead 被当成 0 → “无需推送”，等于静默漏推。
		const originRef = `${ORIGIN_REMOTE}/${TARGET_BRANCH}`;
		const hasOriginRef = git(["rev-parse", "--verify", "--quiet", originRef], worktree).ok;
		const aheadCount = () => {
			if (!hasOriginRef) return Number.NaN;
			const raw = git(["rev-list", "--count", `${originRef}..HEAD`], worktree).stdout;
			return raw ? Number(raw) : Number.NaN;
		};

		const alreadyMerged = git(["merge-base", "--is-ancestor", UPSTREAM_BRANCH, "HEAD"], worktree);
		if (alreadyMerged.ok) {
			const ahead = aheadCount();
			if (!options.push || ahead === 0) {
				log(`✅ ${TARGET_BRANCH} 已包含 ${UPSTREAM_BRANCH} 的全部提交，无需操作`);
				return;
			}
			// 已同步但有未推送提交（如上次门禁失败后本地已合并）：继续走推送
			log(`ℹ️  已包含上游全部提交，但有 ${Number.isNaN(ahead) ? "若干" : ahead} 个待推送提交`);
		} else {
			mergeAndResolve(worktree);
		}

		// 合并后先备好依赖，再跑生成与门禁（比较的是合并结果里的 package-lock.json）
		provisionDependencies(worktree);

		// 生成物重新生成（无论是否冲突都跑：保证生成物与源码一致）
		regenerateArtifacts(worktree);

		// 门禁：类型检查 + 全量测试
		if (!options.skipTests) runGates(worktree);

		if (!options.push) {
			log(`ℹ️  --no-push：已合并并校验通过（临时 worktree 将被清理）。HEAD=${short(git(["rev-parse", "HEAD"], worktree).stdout)}`);
			return;
		}

		const ahead = aheadCount();
		if (ahead === 0) {
			log(`✅ ${ORIGIN_REMOTE}/${TARGET_BRANCH} 已是最新，无需推送`);
			return;
		}
		const pushed = git(["push", ORIGIN_REMOTE, `HEAD:${TARGET_BRANCH}`], worktree);
		if (!pushed.ok) throw new SyncAbort(`推送失败：${firstLine(pushed.stderr)}`);
		log(`✅ 已推送 ${ORIGIN_REMOTE}/${TARGET_BRANCH}（${Number.isNaN(ahead) ? "新" : ahead} 个提交）`);
	} catch (error) {
		warn(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		if (worktree) {
			git(["worktree", "remove", "--force", worktree]);
			git(["worktree", "prune"]);
		}
	}
}

/**
 * 合并 upstream/main 到 worktree，并按 CONFLICT_POLICY 解决冲突。
 * 策略未覆盖的冲突 → 写报告 + abort + 抛 SyncAbort（绝不推送）。
 */
function mergeAndResolve(worktree) {
	const merge = git(["merge", "--no-ff", UPSTREAM_BRANCH, "-m", `Merge ${UPSTREAM_BRANCH} into ${TARGET_BRANCH}（自动同步）`], worktree);
	if (merge.ok) {
		log(`✅ 合并干净：${git(["log", "-1", "--format=%h %s"], worktree).stdout}`);
		return;
	}

	const files = conflictingFiles(worktree);
	log(`⚠️  合并冲突：${files.length} 个文件`);
	for (const file of files) log(`   · ${file} [${classifyConflict(file)}]`);

	const { unresolved, resolved } = resolveConflicts(worktree, files);
	for (const item of resolved) log(`   ✅ ${item.file} → ${item.how}`);

	// 取 custom（ours）的代价：上游对这些文件的改动被放弃。必须显式列出，
	// 否则「上游修了同一个 bug」或「上游修了另一个 bug」都会被默默丢掉。
	// 列出被放弃的上游 diff 供人工复核；门禁（typecheck + 全量测试）是第二道防线。
	const droppedUpstream = resolved.filter((item) => item.how.startsWith("ours")).map((item) => item.file);
	if (droppedUpstream.length > 0) {
		const dropped = droppedUpstream.map((file) => ({ file, upstreamDiff: upstreamSideDiff(worktree, file) }));
		writeConflictReport({
			reason: "custom-priority-applied",
			upstream: UPSTREAM_BRANCH,
			target: TARGET_BRANCH,
			files: droppedUpstream,
			detail: dropped,
		});
		log(`ℹ️  ${droppedUpstream.length} 个文件按「custom 优先」保留，上游侧改动已放弃；`);
		log(`   清单与上游 diff 已写入 ${CONFLICT_REPORT_PATH}（供复核，不阻断合并）`);
	}

	if (unresolved.length > 0) {
		// 策略未覆盖：不推送，留下报告交给人工 / issue
		const detail = unresolved.map((file) => ({ file, content: readConflictBlocks(worktree, file) }));
		writeConflictReport({ reason: "unresolved-conflicts", upstream: UPSTREAM_BRANCH, target: TARGET_BRANCH, files: unresolved, detail });
		git(["merge", "--abort"], worktree);
		throw new SyncAbort(`${unresolved.length} 个冲突不在策略表内，已 abort（未推送）：${unresolved.join(", ")}\n   处理方式见 docs/fork-conflict-policy.md；报告已写入 ${CONFLICT_REPORT_PATH}`);
	}

	const committed = git(["commit", "--no-edit"], worktree);
	if (!committed.ok) throw new SyncAbort(`完成合并提交失败：${firstLine(committed.stderr)}`);
	log(`✅ 冲突已按策略解决并提交：${git(["log", "-1", "--format=%h %s"], worktree).stdout}`);
}

/**
 * 给临时 worktree 准备 node_modules。
 *
 * 生成物脚本（`generate-pi-ai-catalog.mjs`）会读 `node_modules/@earendil-works/pi-ai`，
 * 类型检查与全量测试也都要依赖。新 worktree 里没有 node_modules，直接跑必然失败。
 *
 * 策略：合并后若 package-lock.json 与主仓库**逐字节一致**，直接软链主仓库的
 * node_modules（秒级，避免每次同步都重装）；否则真的 `npm ci`（依赖变了，软链会
 * 拿旧树跑门禁，比不跑更危险）。失败不静默：抛 SyncAbort，宁可不推。
 *
 * 必须在合并**之后**调用：要比较的是合并结果里的 lock，而不是合并前的。
 */
function provisionDependencies(worktree) {
	const mainRoot = git(["rev-parse", "--show-toplevel"]).stdout || process.cwd();
	const mainModules = join(mainRoot, "node_modules");
	const mainLock = join(mainRoot, "package-lock.json");
	const worktreeLock = join(worktree, "package-lock.json");

	const lockMatches = existsSync(mainModules) && existsSync(mainLock) && existsSync(worktreeLock) && readFileSync(mainLock, "utf8") === readFileSync(worktreeLock, "utf8");
	if (lockMatches) {
		symlinkSync(mainModules, join(worktree, "node_modules"), "junction");
		return;
	}

	log("📦 合并后的 package-lock.json 与主仓库不一致（或主仓库无 node_modules）：npm ci …");
	const installed = run(["npm", "ci", "--no-audit", "--no-fund"], worktree);
	if (!installed.ok) {
		throw new SyncAbort(`npm ci 失败，无法跑生成与门禁（未推送）：\n${installed.output.slice(-2000)}`);
	}
}
function regenerateArtifacts(worktree) {
	for (const command of REGENERATE_COMMANDS) {
		const result = run(command, worktree);
		if (!result.ok) throw new SyncAbort(`生成失败：${command.join(" ")}\n${result.output.slice(-2000)}`);
	}
	// fork 补丁重建：同步成功后，补丁必须反映「上游 → 当前 fork」的最新差异，
	// 否则下次上游再改同一文件时，旧补丁会重放失败（→ 开 issue 而非静默丢改动）。
	regenerateForkPatches(worktree);
	const status = git(["status", "--porcelain"], worktree);
	if (status.stdout) {
		log("🔧 生成物/补丁有变化，补一次提交");
		git(["add", "-A"], worktree);
		git(["commit", "-m", "chore(fork): 同步上游后重新生成产物"], worktree);
	}
}

/** 从 `upstream/main..HEAD` 重建每个 PATCH_REPLAY_FILES 的 fork 补丁。 */
function regenerateForkPatches(worktree) {
	mkdirSync(join(worktree, PATCH_DIR), { recursive: true });
	for (const file of PATCH_REPLAY_FILES) {
		const diff = git(["diff", "--binary", `${UPSTREAM_BRANCH}..HEAD`, "--", file], worktree);
		if (!diff.ok) throw new SyncAbort(`生成补丁失败：${file}`);
		const target = join(worktree, PATCH_DIR, `${basename(file)}.patch`);
		// 上游与 fork 当前无差异时写空补丁文件（下次同步不会误判为“缺补丁”）
		writeFileSync(target, diff.stdout ? `${diff.stdout}\n` : "", "utf8");
	}
}

/** 门禁：typecheck + 全量测试；失败写报告并中止（不推送）。 */
function runGates(worktree) {
	log("🔍 npm run typecheck …");
	const typecheck = run(["npm", "run", "typecheck"], worktree);
	if (!typecheck.ok) {
		writeConflictReport({ reason: "typecheck-failed", upstream: UPSTREAM_BRANCH, target: TARGET_BRANCH, output: typecheck.output.slice(-4000) });
		throw new SyncAbort(`typecheck 失败，已中止（未推送）。输出见 ${CONFLICT_REPORT_PATH}\n${typecheck.output.slice(-2000)}`);
	}
	log("🧪 npm run test:serial …");
	const tests = run(["npm", "run", "test:serial"], worktree);
	if (!tests.ok) {
		writeConflictReport({ reason: "tests-failed", upstream: UPSTREAM_BRANCH, target: TARGET_BRANCH, output: tests.output.slice(-6000) });
		throw new SyncAbort(`测试失败，已中止（未推送）。输出见 ${CONFLICT_REPORT_PATH}\n${tests.output.slice(-2000)}`);
	}
}

/** 读取冲突块原文（issue 正文用）；文件不可读返回空串。 */
function readConflictBlocks(worktree, file) {
	try {
		const content = readFileSync(join(worktree, file), "utf8");
		const blocks = [];
		let capturing = false;
		let current = [];
		for (const line of content.split("\n")) {
			if (line.startsWith("<<<<<<<")) {
				capturing = true;
				current = [line];
			} else if (capturing && line.startsWith(">>>>>>>")) {
				current.push(line);
				blocks.push(current.join("\n"));
				capturing = false;
			} else if (capturing) {
				current.push(line);
			}
		}
		return blocks.slice(0, 10).join("\n\n");
	} catch {
		return "";
	}
}

/** 只有被直接执行为入口时才跑主流程：顶层导出纯函数供单测 import。 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
