/**
 * 更新源坐标与 URL 拼接契约 —— 主进程与渲染层共用，禁止 import 运行时层。
 *
 * ## 两套坐标（本 fork 的关键拆分）
 *
 * 本仓库是 PiDeck 的 fork，**应用更新**与**内容更新**指向不同仓库：
 *
 * | 用途 | 坐标 | 谁在用 |
 * |---|---|---|
 * | **应用更新**（PiDeck 自身的安装包） | `APP_UPDATE_REPO_*` = `coo0/PiDeck` | `main/update/releaseRepo.ts`、`package.json build.publish` |
 * | **内容更新**（模型目录 / 内置扩展 / 技能 / 提示词 / DSH runtime / Node 侧车 / 公告 / CHANGELOG） | `UPDATE_REPO_*` = `ayuayue/PiDeck` | 各内容 updater |
 *
 * 为什么拆：fork 有自己的 Release（应用要能从自己的 Release 升级），但**不重建**上游
 * 的内容资产（DSH runtime tgz、Node 侧车、模型目录等）。若两套坐标共用一个常量，改任
 * 一边都会让另一边 404。上游（ayuayue）仓库本身两套坐标相同，所以上游代码只有一组常量。
 *
 * 因此 `UPDATE_REPO_*` 在本 fork 中语义是「**内容**源坐标」，与上游同名同值（ayuayue），
 * 保证 4 个内容文件（`atomGitContents` / `ChangelogService` / `announcementSources` /
 * `PiAiCatalogUpdater`）零 diff，减少同步上游时的冲突面。应用侧一律用 `APP_UPDATE_REPO_*`。
 *
 * ## 应用更新为什么走原生 provider 而不是 generic feed
 *
 * `settings.updateSource` 的 atomgit 分支拼的是 `atomgit.com/<owner>/<repo>/releases/download/latest`。
 * fork 没有 AtomGit 镜像，所以应用更新**固定**走 electron-updater 原生 GitHub provider
 * （`package.json build.publish` → `app-update.yml`）。`updateSource` 仅用于内容更新。
 *
 * GitHub provider 的 githubUrl() 只支持 host 覆盖（企业版语义），拼不出
 * 「https://<镜像>/https://github.com/...」前缀代理的路径，因此镜像走 generic provider：
 * 把 `镜像前缀 + /ayuayue/PiDeck/releases/latest/download` 整体作为 feed baseUrl。
 */

import type { UpdateSourceId } from "./types/settings";

/**
 * **内容**更新所指向的 GitHub 仓库坐标（上游，唯一事实来源）。
 * 与上游同名同值，刻意不改：fork 不重建内容资产，继续吃上游的内容热更新。
 */
export const UPDATE_REPO_OWNER = "ayuayue";
export const UPDATE_REPO = "PiDeck";

/**
 * **应用**更新所指向的 GitHub 仓库坐标（本 fork）。
 *
 * 唯一事实来源是 `package.json` 的 `build.publish`（electron-updater 原生 provider 读它，
 * 打包时写进 `app-update.yml`）；`main/update/releaseRepo.ts` 的常量与此**必须一致**。
 * 本文件只服务渲染层的展示/校验，不参与应用更新的实际请求拼接。
 */
export const APP_UPDATE_REPO_OWNER = "coo0";
export const APP_UPDATE_REPO = "PiDeck";

/** generic feed 的固定路径段：GitHub 把 `releases/latest/download/<asset>` 302 到当前最新 release。 */
export const RELEASES_LATEST_DOWNLOAD_PATH = "/releases/latest/download";

/** AtomGit 托管根域名。 */
export const ATOMGIT_HOST = "https://atomgit.com";

/**
 * AtomGit OpenAPI 根域名（注意与托管域名不同：api.atomgit.com）。
 *
 * 匿名 `/raw/` 路径已被 GitCode 前端应用接管（返回 SPA HTML 壳 + 易盾验证码 SDK），
 * 程序化取文件内容必须走官方开放接口：
 * `GET {ATOMGIT_API_HOST}/api/v5/repos/:owner/:repo/contents/:path?ref=<branch>`
 * 返回 JSON（content 为 base64），匿名可读公开仓库（实测 5 连发均 ~0.4s 无限速）。
 */
export const ATOMGIT_API_HOST = "https://api.atomgit.com";

/** AtomGit Release 仓库根路径（内容源），例如 `https://atomgit.com/ayuayue/PiDeck`。 */
export function atomGitReleasesBase(): string {
	return `${ATOMGIT_HOST}/${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
}

/** AtomGit Release generic feed baseUrl（内容资产下载自此路径）。 */
export function atomGitFeedUrl(): string {
	return `${atomGitReleasesBase()}/releases/download/latest`;
}

/**
 * AtomGit latest release 的 OpenAPI。
 *
 * 网页 `atomgit.com/.../releases/latest` 是 SPA 壳，不会像 GitHub 那样 302 到
 * `/releases/tag/vX.Y.Z`，程序化读版本必须走 JSON 的 `tag_name`。
 */
export function atomGitLatestReleaseApiUrl(): string {
	return `${ATOMGIT_API_HOST}/api/v5/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/latest`;
}

/** 内容更新镜像清单：保留 AtomGit 作为国内加速源（第一首选）；github 走原生链路。 */
export const UPDATE_SOURCE_MIRRORS: ReadonlyArray<{ id: UpdateSourceId; host: string }> = [{ id: "atomgit", host: ATOMGIT_HOST }];

/** GitHub Release 仓库根路径（内容源），例如 `https://github.com/ayuayue/PiDeck`。 */
export function gitHubReleasesBase(): string {
	return `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
}

/**
 * GitHub latest 资产根路径（内容源），例如 `https://github.com/ayuayue/PiDeck/releases/latest/download`。
 * 与 AtomGit 的 `/releases/download/latest` 路径不同，两边不能共用同一套拼接。
 */
export function gitHubLatestDownloadBase(): string {
	return `${gitHubReleasesBase()}${RELEASES_LATEST_DOWNLOAD_PATH}`;
}

/** 镜像前缀 → generic feed baseUrl。对于 atomgit 直接返回 atomgit feed url。 */
export function buildCustomSourceFeedUrl(host: string): string {
	if (host === ATOMGIT_HOST || host.startsWith(ATOMGIT_HOST)) {
		return atomGitFeedUrl();
	}
	return `${host}/${gitHubReleasesBase()}${RELEASES_LATEST_DOWNLOAD_PATH}`;
}

/**
 * 规范化自定义镜像前缀：trim、去尾斜杠、强制 https/http。非法/空返回 null（UI 实时校验用）。
 */
export function normalizeCustomMirrorHost(raw: string | null | undefined): string | null {
	const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
	if (!trimmed) return null;
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		if (!parsed.hostname) return null;
		return trimmed;
	} catch {
		return null;
	}
}
