import { spawn } from "node:child_process";
import type { ExternalEditor } from "../../shared/types";

export type OpenPath = (path: string) => Promise<string>;
export type OpenTextPath = (path: string) => Promise<void>;
export type OpenInEditor = (editor: ExternalEditor, path: string) => Promise<void>;
export type ListEditors = () => Promise<ExternalEditor[]>;

export type OpenFileFallbackDeps = {
	openPath: OpenPath;
	platform?: string;
	listEditors?: ListEditors;
	openInEditor?: OpenInEditor;
	openTextPath?: OpenTextPath;
};

/**
 * 用系统默认关联程序打开文件，失败时按平台能力逐级回退。
 *
 * 背景（用户反馈）：macOS 上点击「打开会话文件」报 `Failed to open path`。
 * 会话文件是 `.jsonl`，LaunchServices 没有默认关联程序，`open` 返回
 * kLSApplicationNotFoundErr(-10814)；Electron 的 `shell.openPath` 把系统错误文本
 * 原样返回，用户只看到一句无信息量的报错，文件根本打不开。
 *
 * 回退顺序（每级失败才进入下一级，全部失败时抛出最初的系统错误以保留诊断信息）：
 * 1. 系统默认关联程序 —— 有正常关联时行为完全不变；
 * 2. 用户已启用的外部编辑器（VS Code / Cursor / JetBrains…）—— JSONL 用编辑器打开
 *    可读性和大文件性能都远好于系统文本编辑器；
 * 3. macOS 系统文本编辑器（`open -t`）—— 兜底，保证用户至少能看到内容。
 *
 * 非 macOS 平台保持原行为：系统默认关联程序失败即抛出，不引入额外回退。
 */
export async function openPathWithFallback(path: string, deps: OpenFileFallbackDeps): Promise<void> {
	const platform = deps.platform ?? process.platform;
	const error = await deps.openPath(path);
	if (!error) return;
	if (platform !== "darwin") throw new Error(error);

	// 外部编辑器优先于系统文本编辑器：JSONL 是纯文本，编辑器体验明显更好。
	// 任一级成功即返回；失败只记录并继续下一级，最终抛出的仍是系统原始报错。
	if (deps.listEditors && deps.openInEditor) {
		try {
			const editors = await deps.listEditors();
			// 只取第一个已启用编辑器：用户点「打开会话文件」期望的是「打开」，
			// 弹一个编辑器选择列表会把一次点击变成一次决策。
			const editor = editors[0];
			if (editor) {
				await deps.openInEditor(editor, path);
				return;
			}
		} catch {
			// 编辑器启动失败（未安装/被移动/权限）：继续走系统文本编辑器兜底。
		}
	}

	try {
		await (deps.openTextPath ?? openWithMacTextEditor)(path);
	} catch {
		throw new Error(error);
	}
}

function openWithMacTextEditor(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("open", ["-t", path], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`open -t exited with code ${code ?? "unknown"}`));
		});
	});
}
