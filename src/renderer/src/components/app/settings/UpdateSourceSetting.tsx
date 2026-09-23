import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, MirrorHealthResult, UpdateSourceId } from "../../../../../shared/types/settings";
import { ATOMGIT_HOST, UPDATE_SOURCE_MIRRORS, buildCustomSourceFeedUrl, normalizeCustomMirrorHost } from "../../../../../shared/updateSources";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingRow } from "./SettingRows";

/** 镜像健康状态点配色：ok=绿（可用）、slow=黄（较慢）、broken=红（不可用）；未探测=灰。 */
const HEALTH_DOT_CLASS: Record<MirrorHealthResult["status"], string> = {
	ok: "bg-emerald-500",
	slow: "bg-amber-500",
	broken: "bg-red-500",
};

/**
 * 设置「版本与更新」下的**内容更新源**选择。
 *
 * 本 fork 的关键语义：这个开关只影响**内容更新**（模型目录 / 内置扩展 / 技能 /
 * 提示词 / DSH runtime / Node 侧车 / 公告 / CHANGELOG），**不影响应用自身更新**。
 * 应用更新固定走 `github.com/coo0/PiDeck` 的 GitHub 原生通道（见 releaseRepo.ts），
 * 因为 fork 没有 AtomGit 镜像——旧版把 atomgit 分支用在应用更新上会让 feed 指向
 * 上游不存在的 Release。
 *
 * 下拉项：
 * - AtomGit 镜像（`UPDATE_SOURCE_MIRRORS`，域名即地址）→ 内容更新走 AtomGit，国内更快；
 * - GitHub 官方 → 内容更新走 raw.githubusercontent（源站权威）。
 *
 * 挂载时自动体检内置镜像（latest.yml + Range 分片），下拉项前显示状态色点与实测速度，
 * 可手动「重新检测」——镜像域名可用性/速度波动大，静态维护不可靠（见 main/update/mirrorHealth.ts）。
 */
export function UpdateSourceSetting(props: { draft: AppSettings; updateDraft: (patch: Partial<AppSettings>) => void }) {
	const { draft, updateDraft } = props;
	const source: UpdateSourceId = draft.updateSource ?? "atomgit";

	// 镜像体检结果（按更新源 id 索引；null 表示尚未完成首次探测）
	const [mirrorHealth, setMirrorHealth] = useState<Record<string, MirrorHealthResult> | null>(null);
	const [probing, setProbing] = useState(false);

	// 当前生效的内容源地址（atomgit → AtomGit generic feed 地址；github → 内置官方通道）。
	const activeFeedUrl: string | null = (() => {
		if (source === "github") return null;
		const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
		return mirror ? buildCustomSourceFeedUrl(mirror.host) : buildCustomSourceFeedUrl(ATOMGIT_HOST);
	})();

	// 并行体检内置更新源；期间锁定 probing，防止重复触发（重新检测按钮也走同一入口）。
	const probeMirrors = useCallback(async () => {
		if (probing) return;
		setProbing(true);
		try {
			const results = await desktopApi.app.checkUpdateMirrors();
			const byId: Record<string, MirrorHealthResult> = {};
			for (const r of results) byId[r.id] = r;
			setMirrorHealth(byId);
		} catch {
			// 探测失败（IPC 异常）不阻塞设置页：保留上次结果，静默忽略。
			setMirrorHealth(null);
		} finally {
			setProbing(false);
		}
	}, [probing]);

	// 打开设置页即自动体检一次，后续由「重新检测」按钮触发
	useEffect(() => {
		void probeMirrors();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时探测一次
	}, []);

	// 更新源状态点渲染；未探测/探测中显示灰色占位，避免下拉项宽度跳动
	const healthDot = (id: string) => {
		const h = mirrorHealth?.[id];
		if (!h) return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
		return <span className={`size-1.5 rounded-full ${HEALTH_DOT_CLASS[h.status]}`} />;
	};

	// 更新源行右侧的实测速度/延迟文本（broken 时显示原因）
	const healthText = (id: string) => {
		const h = mirrorHealth?.[id];
		if (!h) return null;
		if (h.status === "ok") return t("settings.updateMirrorOk", { speed: h.speedKBps, latency: h.latencyMs });
		if (h.status === "slow") return t("settings.updateMirrorSlow", { speed: h.speedKBps, latency: h.latencyMs });
		return t("settings.updateMirrorBroken", { error: h.error ?? "?" });
	};

	return (
		<>
			<SettingRow
				title={t("settings.updateSource")}
				description={
					// 描述区直接展示当前生效的完整 feed URL
					activeFeedUrl ? t("settings.updateSourceFeedPreview", { url: activeFeedUrl }) : t("settings.updateSourceFeedOfficial")
				}
			>
				<Select value={source} onValueChange={(value) => updateDraft({ updateSource: value as UpdateSourceId })}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{/* AtomGit 第一首选 */}
						{UPDATE_SOURCE_MIRRORS.map((mirror) => (
							<SelectItem key={mirror.id} value={mirror.id}>
								<span className="flex items-center gap-2">
									{healthDot(mirror.id)}
									<span>{t("settings.updateSourceAtomGit")}</span>
									{healthText(mirror.id) && <span className="text-muted-foreground">{healthText(mirror.id)}</span>}
								</span>
							</SelectItem>
						))}
						{/* GitHub 官方 */}
						<SelectItem value="github">{t("settings.updateSourceGithub")}</SelectItem>
					</SelectContent>
				</Select>
			</SettingRow>

			{/* 体检状态栏：仅 AtomGit 展示；github 官方链路不参与内置探测 */}
			{source === "atomgit" &&
				(() => {
					const text = mirrorHealth?.atomgit ? healthText("atomgit") : null;
					return (
						<div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
							<span className="flex items-center gap-2">
								{healthDot("atomgit")}
								{probing || !text ? t("settings.updateMirrorChecking") : text}
							</span>
							<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={probing} onClick={() => void probeMirrors()}>
								{t("settings.updateMirrorRetest")}
							</Button>
						</div>
					);
				})()}
		</>
	);
}
