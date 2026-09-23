# 本仓库是 PiDeck 的个人 fork

上游：<https://github.com/ayuayue/PiDeck>（作者 ayuayue）
本 fork：<https://github.com/coo0/PiDeck>

这份文件是 fork 自己的维护说明，上游没有同名文件，因此**不会在同步上游时产生冲突**。
上游的仓库规则见 `AGENTS.md`（合并上游后以上游版本为主体）。

## 分支模型

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 上游镜像 | **只允许 fast-forward**。永远等于 `upstream/main`，不放任何自有提交 |
| `custom` | 自有版本 | 所有个人改动都在这里；定期把 `upstream/main` merge 进来 |
| `backup/*` | 一次性备份 | 大规模操作前的安全网，确认无误后可删 |

为什么不让 `main` 直接承载自有改动：上游更新频率很高（单次合并可达近百个提交），
把自有提交和上游提交混在一条线上，每次同步都要在全部文件里解冲突；分开之后
冲突只发生在一个 merge 提交里，且 `custom` 随时可以丢弃重建。

## 同步上游

### 自动（默认）

`.github/workflows/fork-sync-upstream.yml` 每日 03:17 UTC 自动跑 `scripts/sync-upstream.mjs`：
合并 `upstream/main` → 按 `docs/fork-conflict-policy.md` 解冲突 → 重新生成生成物 →
typecheck + 全量测试门禁 → 全绿才推 `custom`。策略未覆盖的冲突或门禁失败时**不推送**，
开 issue 并附冲突报告。

### 手动

```bash
npm run sync:upstream                # 合并 + 校验 + 推送
npm run sync:upstream -- --dry-run   # 只预览会并入什么
npm run sync:upstream -- --no-push   # 合并 + 校验，不推送
```

脚本在临时 worktree 里合并，不影响当前工作区；冲突解法交给 `rerere` 记住，下次自动重放。

### 冲突策略

见 `docs/fork-conflict-policy.md`（分区表 + 并集规则）。三个关键点：

1. **fork 身份文件取 fork**（`FORK.md`、`.githooks/pre-push`、`releaseRepo.ts`、
   `src/shared/updateSources.ts`）；
2. **上游组装层取上游 + 重放 fork 补丁**（`App.tsx`、`ComposerComponents.tsx`）。
   补丁在 `scripts/fork-patches/`，每次同步成功后自动从 `upstream/main..HEAD` 重建；
3. **生成物取上游后重新生成**，禁止手工解。

`package.json` 是字段级特例：保留 fork 的 `build.publish.owner` / `build.appId` / `repository`，
其余（version / deps / scripts）取上游。

### 首次配置（新设备）

```bash
git remote add upstream https://github.com/ayuayue/PiDeck.git
git fetch upstream --tags
```

## 发布（fork 自有 Release）

`.github/workflows/fork-release.yml`（手动触发）：macOS（dmg/zip，arm64+x64）+ Windows
（nsis/portable/zip）→ **draft Release**，人工确认后 Publish。

- tag 约定 `v<version>-custom.<N>`（如 `v0.7.7-custom.1`），避开上游 tag 命名空间；
- 构建时把 tag 版本写回 `package.json`（`npm version`）——electron-updater 按预发布
  channel 匹配 release，版本不一致会导致「永远说已是最新」；
- 用默认 `GITHUB_TOKEN`，不需要 `RELEASE_PAT`（fork 不做 AtomGit 镜像）。

## 推送

```bash
git push origin custom
```

`origin` 指向本 fork（`git@github.com:coo0/PiDeck.git`）。`main` 是上游镜像，只允许 fast-forward：

```bash
git switch main && git merge --ff-only upstream/main && git push origin main
git switch custom
```

## 一次性 GitHub 设置

GitHub 的 `schedule` 与 `workflow_dispatch` **只认默认分支上的 workflow 文件**
（上游 `post-release-sidecars.yml` 也依赖同一机制）。本 fork 的默认分支是 `main`，
但 `main` 要保持「上游纯镜像」（只允许 fast-forward），不能放 fork 工作流。

因此需要在 GitHub 仓库设置里把**默认分支改为 `custom`**：

> Settings → General → Default branch → 切换到 `custom`

改完之后：`fork-sync-upstream.yml` 的每日定时与 `fork-release.yml` 的手动触发都会生效，
且 `main` 仍可 `merge --ff-only upstream/main`。

另外建议在 fork 上**禁用 `star-history.yml`**：它是 `schedule` + `contents: write`，
会把 star 历史提交推到默认分支（改默认分支后会推到 `custom`，干扰自动同步）。
（fork 一般不需要 star 历史图。）

**本 fork 关闭了 Issues**（`has_issues: false`），因此 `fork-sync-upstream.yml` 的失败通知
以 **job summary** 为主通道（一定可用），issue 为尽力而为（失败只告警不报错）。
若想同时收到 issue，需到 Settings → General → Features 勾上 Issues。

其余依赖 `RELEASE_PAT` / `ATOMGIT_TOKEN` 的上游 workflow（`release.yml`、
`sync-atomgit.yml`、`post-release-sidecars.yml`、`publish-dsh-*`）在 fork 上会因缺 secret
而失败；它们只由 tag push / release 事件触发，不干扰日常同步，但建议一并禁用。

## 与上游的刻意差异

这些差异是**有意的**，合并上游时不要被上游版本覆盖掉：

### 1. pre-push 钩子不镜像到上游 AtomGit

`.githooks/pre-push` 顶部固定了 `export PI_DECK_SKIP_ATOMGIT=1`。
上游把这个钩子用作「把推送镜像到作者自己的 AtomGit 仓库」的通道
（`scripts/atomgit-mirror.mjs` 的 `DEFAULT_ATOMGIT_URL` 指向 `atomgit.com/ayuayue/PiDeck`），
本 fork 不向任何上游仓库写入，因此跳过。

镜像脚本本体与 `tests/atomgitPushMirror.test.mjs` **保持与上游逐字一致**，只改钩子那一行，
这样后续 merge 只需处理这一个冲突点。想恢复镜像：删掉那一行，或设
`PI_DECK_ATOMGIT_URL` 指向自己的 AtomGit 仓库。

### 2. 应用更新指向本 fork，内容更新仍指向上游（已拆分）

| 用途 | 坐标 | 谁在用 |
|---|---|---|
| **应用更新**（PiDeck 自身安装包） | `coo0/PiDeck` | `package.json build.publish`、`src/main/update/releaseRepo.ts` |
| **内容更新**（模型目录 / 内置扩展 / 技能 / 提示词 / DSH runtime / Node 侧车 / 公告 / CHANGELOG） | `ayuayue/PiDeck` | `src/shared/updateSources.ts` 的 `UPDATE_REPO_*` |

**关键：两套坐标已解耦**（上游只有一套）。`settings.updateSource` 现在**只驱动内容更新**，
应用更新固定走 GitHub 原生 provider（`build.publish` → `app-update.yml`）——因为 fork 没有
AtomGit 镜像，旧实现会把应用 feed 指向 `atomgit.com/ayuayue/PiDeck`（不存在）。

后果与取舍：

- 应用更新**不能**切国内镜像（fork 无镜像）；设置页「内容更新源」只影响内容。
- 内容更新继续吃上游（fork 不重建 DSH runtime / Node 侧车等资产）。
- `src/shared/updateSources.ts` 的 `UPDATE_REPO_*` 与上游**同名同值**（ayuayue），
  刻意保持 4 个内容文件零 diff，减少同步冲突面。

### 3. 应用身份（appId / productName）保持上游

`package.json` 的 `build.appId` 仍是 `com.ayuayue.pi-desktop`，`productName` 仍是 `PiDeck`。

后果：本 fork 打的包与原版 PiDeck 会**互相覆盖安装**、共用 `%APPDATA%/pi-desktop`
数据目录（macOS 为 `~/Library/Application Support/pi-desktop`）。

**单实例锁不冲突**：锁按版本号隔离（`userData/instance-locks/<version>.lock`），
`v0.7.7-custom.1` 与上游 `v0.7.7` 可同时运行。

好处：官方版 ↔ fork 版切换不丢配置（读同一份 settings/projects）。
若要隔离，需同时改 `build.appId`、`app.setAppModelId`、`PACKAGED_USER_DATA_NAME`，
属破坏性变更（读不到旧配置）。

## 保留的自有能力

合并上游时这些改动要保住（均在 `custom` 分支）：

- **终端 GPU 渲染 + 终端设置页** — xterm WebGL2 渲染器（含 DOM 回退）、search / replay
  serialization / Unicode 11 三个 addon、Tab 切换用 xterm serializer 恢复、
  `TerminalTab.tsx` 设置页（配色 / 字体 / 字号 / 内边距 / scrollback / 光标 / 选中即复制 /
  关闭确认 / 启动命令）
- **用量探针迁移与输入区显示**
- **扩展网关瞬态错误重试** — `resources/extensions/pi-deck-retry-no-body.ts` 补两类
  pi 重试名单漏掉的瞬态故障
- **`AGENTS.md` 英文重写** 与 README / docs-site 共享图片、prompt/skill manifest 两节

## 生成物注意

`resources/extensions/extensions-manifest.json` 是生成物，**不要手工解冲突**：

```bash
node scripts/generate-extensions-manifest.mjs          # 重新生成
node scripts/generate-extensions-manifest.mjs --check  # 校验
```

同理，`resources/prompts/*.md`、`resources/skills/*/SKILL.md`、`resources/pi-ai-catalog.json`、
`announcements.json` 都有各自的生成脚本与 `check:*` 命令（见 `AGENTS.md` 的
「Generator → artifact → guard」表）。
