import { net } from "electron";
import { compareVersions } from "../utils/versionCompare";
import { LATEST_RELEASE_API_URL } from "./releaseRepo";

/** GitHub Releases API 的 latest release JSON endpoint。 */
export const MAC_MANUAL_LATEST_RELEASE_URL = LATEST_RELEASE_API_URL;

export type ManualReleaseCheckResult = {
	latestVersion: string;
	hasUpdate: boolean;
};

export type LatestReleaseResponse = {
	ok: boolean;
	status: number;
	url: string;
	/** OpenAPI JSON 正文。GitHub HTML 重定向路径不需要 body。 */
	body?: string;
};

type LatestReleaseFetcher = (url: string) => Promise<LatestReleaseResponse>;

/**
 * 从 GitHub latest release 重定向 URL 提取发布版本。
 * URL 例：`https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4`。
 * AtomGit 网页 `/releases/latest` 不会 302 到这种路径，返回 null。
 */
export function parseGitHubReleaseVersion(url: string): string | null {
	try {
		const pathname = new URL(url).pathname;
		const match = pathname.match(/\/releases\/tag\/v?([^/?#]+)$/i);
		return match?.[1] ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

/**
 * AtomGit / GitHub REST 的 latest release JSON：版本写在 `tag_name`。
 * 例：`{"tag_name":"v0.7.6"}` → `"0.7.6"`。
 */
export function parseLatestReleaseTagFromJson(body: string): string | null {
	try {
		const payload: unknown = JSON.parse(body);
		if (typeof payload !== "object" || payload === null || !("tag_name" in payload)) {
			return null;
		}
		const tag = payload.tag_name;
		if (typeof tag !== "string") return null;
		const trimmed = tag.trim();
		if (!trimmed) return null;
		return trimmed.replace(/^v/i, "");
	} catch {
		return null;
	}
}

/**
 * 优先从 Releases API JSON 的非空 `tag_name` 取版本；兼容旧 fetcher 的 GitHub tag 最终 URL。
 */
export function resolveLatestReleaseVersion(response: Pick<LatestReleaseResponse, "url" | "body">): string | null {
	return (response.body ? parseLatestReleaseTagFromJson(response.body) : null) ?? parseGitHubReleaseVersion(response.url);
}

/**
 * 默认 fetcher 读取 API 响应正文；GitHub Releases API 的版本号始终来自 JSON 的 `tag_name`。
 */
export function shouldReadJsonBody(url: string, contentType: string): boolean {
	if (/\bjson\b/i.test(contentType)) return true;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "api.atomgit.com" || host === "api.github.com";
	} catch {
		return false;
	}
}

/**
 * macOS 无签名分发的更新检测器。
 *
 * 不调用 electron-updater：该路径在没有 Developer ID 签名/公证时无法承诺可靠
 * 的下载、替换和重启体验。随后由 UI 打开 Release 页面交给用户手动安装。
 *
 * GitHub 源：请求 Releases API 的 `/repos/:owner/:repo/releases/latest`，从 JSON 的 `tag_name` 取版本。
 * 随后由 UI 打开 Release 页面交给用户手动安装。
 */
export function createMacManualUpdateChecker(options?: { fetchLatestRelease?: LatestReleaseFetcher }): (currentVersion: string, latestReleaseUrl?: string) => Promise<ManualReleaseCheckResult> {
	const fetchLatestRelease =
		options?.fetchLatestRelease ??
		(async (url: string): Promise<LatestReleaseResponse> => {
			const response = await net.fetch(url, { redirect: "follow" });
			const body = await response.text();
			return { ok: response.ok, status: response.status, url: response.url || url, body };
		});

	return async (currentVersion: string, latestReleaseUrl?: string): Promise<ManualReleaseCheckResult> => {
		const response = await fetchLatestRelease(latestReleaseUrl ?? MAC_MANUAL_LATEST_RELEASE_URL);
		if (!response.ok) {
			throw new Error(`Latest release request failed (${response.status}).`);
		}
		const latestVersion = resolveLatestReleaseVersion(response);
		if (!latestVersion) {
			throw new Error("Latest release response did not resolve to a release tag.");
		}
		return {
			latestVersion,
			hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		};
	};
}
