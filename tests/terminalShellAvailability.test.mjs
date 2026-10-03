/**
 * shell 可用性探测（TerminalSessionManager.isShellCommandAvailable + listShells）。
 *
 * 修掉的缺陷：listShells 曾对每个候选恒返回 available: true，与自己 JSDoc 的契约矛盾，
 * TerminalDock 里的置灰分支因此是死代码。判定必须只做存在性检查（不 spawn PTY）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isShellCommandAvailable } = loadTsCommonJs("src/main/terminal/TerminalSessionManager.ts", {
	stubs: { "node-pty": {} },
});

test("absolute and relative paths use real file existence", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-shell-"));
	try {
		const shell = join(root, "test-shell");
		writeFileSync(shell, "fixture");
		assert.equal(isShellCommandAvailable(shell), true);
		assert.equal(isShellCommandAvailable(join(root, "missing-shell")), false);
		assert.equal(isShellCommandAvailable(relative(process.cwd(), shell)), true);
		assert.equal(isShellCommandAvailable(relative(process.cwd(), join(root, "missing-shell"))), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const platform of ["win32", "darwin", "linux"]) {
	test(`${platform}: bare commands resolve only through the supplied PATH`, () => {
		const sep = platform === "win32" ? "\\" : "/";
		const bin = platform === "win32" ? "C:\\shells" : "/shells";
		const present = new Set([`${bin}${sep}test-shell${platform === "win32" ? ".exe" : ""}`, `${bin}${sep}already-suffixed.exe`]);
		const { isShellCommandAvailable: probe } = loadTsCommonJs("src/main/terminal/TerminalSessionManager.ts", {
			globals: { process: { platform, env: { PATH: `${platform === "win32" ? "C:\\missing;" : "/missing:"}${bin}` } } },
			stubs: { "node-pty": {}, "node:path": { sep }, "node:fs": { existsSync: (path) => present.has(path) } },
		});
		assert.equal(probe("test-shell"), true);
		assert.equal(probe("already-suffixed.exe"), true);
		assert.equal(probe("missing-shell"), false);
		assert.equal(probe("./test-shell"), false, "相对路径不得借 PATH 命中");
	});
}
