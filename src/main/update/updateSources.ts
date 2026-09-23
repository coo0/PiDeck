/**
 * 更新源设置的归一化与查询 —— 主进程侧编排逻辑。
 *
 * 本 fork 中 `settings.updateSource` **只驱动内容更新**（模型目录 / 内置扩展 / 技能 /
 * 提示词 / DSH runtime / Node 侧车 / 公告 / CHANGELOG）；应用更新固定走
 * `github.com/coo0/PiDeck` 原生 provider（见 `main/update/releaseRepo.ts`）。
 * 因此这里不再提供应用 feed URL 的拼接函数——那些曾把应用更新指向
 * `atomgit.com/ayuayue/PiDeck`，而本 fork 没有 AtomGit 镜像。
 *
 * 纯数据与拼接规则在 shared/updateSources.ts（主/渲染共用同一份清单，UI 展示与
 * 内容 URL 生成自动同步）。
 */

import type { UpdateSourceId } from "../../shared/types/settings";
import { normalizeCustomMirrorHost } from "../../shared/updateSources";

export { normalizeCustomMirrorHost }; // 再导出，供调用点单一来源

/** 校验设置里的更新源 id 是否已知；未知值回退 atomgit（内容源首选）。 */
export function normalizeUpdateSource(source: unknown): UpdateSourceId {
	const id = typeof source === "string" ? (source as UpdateSourceId) : "atomgit";
	return id === "atomgit" || id === "github" ? id : "atomgit";
}
