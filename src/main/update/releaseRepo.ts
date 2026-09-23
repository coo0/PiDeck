/**
 * **应用更新**所指向的 GitHub 仓库坐标（唯一事实来源）。
 *
 * 本仓库是 PiDeck 的 fork：应用更新指向自己的 Release（`coo0/PiDeck`），而内容更新
 * （模型目录 / 内置扩展 / DSH runtime / Node 侧车 / 公告 / CHANGELOG）继续指向上游
 * `ayuayue/PiDeck`。两套坐标的完整说明见 `src/shared/updateSources.ts` 顶部注释。
 *
 * electron-updater 的 GitHub provider 从 package.json build.publish 读取仓库坐标
 * （打包时写进 app-update.yml），**不读这里的常量**；本常量供
 *   - 兜底 app-update.yml 生成（便携版/缺失配置时，见 createAutoUpdater.ts）
 *   - 运行时显式重建 GitHub provider（setFeedUrl(null) 恢复官方源）
 *   - 设置页「版本与更新」的 Release 页面地址
 * 使用。三者必须与 `build.publish` 保持一致，否则更新检查会指向 404。
 *
 * 禁止回填旧名 pi-desktop：仓库已更名，旧坐标只能靠 GitHub 改名重定向工作，
 * 一旦重定向失效（旧名被他人注册/回收）更新检查会直接 404。
 */
export const UPDATE_REPO_OWNER = "coo0";
export const UPDATE_REPO = "PiDeck";

export const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
