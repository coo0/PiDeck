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

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main        # 纯净跟进，不做 merge 提交
git switch custom
git merge upstream/main                  # 冲突都在这一步
# 解冲突 → 跑校验 → 提交
npm run typecheck
node --test tests/<受影响>.test.mjs
```

首次配置（新设备）：

```bash
git remote add upstream https://github.com/ayuayue/PiDeck.git
git fetch upstream --tags
```

## 推送

```bash
git push origin main
git push origin custom
```

`origin` 指向本 fork（`git@github.com:coo0/PiDeck.git`）。

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

### 2. UI 展示链接指向本 fork，更新链路仍指向上游

| 位置 | 指向 | 原因 |
|---|---|---|
| 关于弹框「GitHub」行 | `github.com/coo0/PiDeck` | 展示用，指向本 fork |
| 反馈弹框 / 诊断报告 | `github.com/coo0/PiDeck` | 问题应提到本 fork |
| 推荐扩展的 `repoUrl` | `github.com/coo0/PiDeck` | 展示用 |
| 控制台「报告 bug」 | `github.com/coo0/PiDeck` | 展示用 |
| **应用更新源**（`build.publish` / `releaseRepo.ts` / `updateSources.ts`） | **上游 ayuayue** | 本 fork 不发 Release，指向自己会 404 |
| **内容更新**（模型目录 / 内置扩展 / 技能 / 提示词 / DSH runtime / Node） | **上游 ayuayue** | 继续享受上游内容更新 |
| 文档站 / 浏览器面板首页 | 上游 `ayuayue.github.io/PiDeck` | 本 fork 没有 Pages，指过去会 404 |

**关键约束：更新链路与内容更新共用同一个开关。**
`settings.updateSource`（`"atomgit" | "github"`）同时驱动应用更新与全部内容更新
（`UpdateService` 与 6 个 updater 都读它），两者共用 `src/shared/updateSources.ts` 的
`UPDATE_REPO_OWNER`。因此**无法只改应用更新源而保留内容源**。

要真正拆开需要一次重构：新增 `appUpdateRepo` / `contentRepo` 两组坐标常量，并把
`settings` 的单一 `updateSource` 拆成独立的应用源与内容源开关。改动会波及约 10 个
测试文件（`updateSources.test.mjs` / `dshRuntimeManager.test.mjs` / `dshRunnerNodeInstall.test.mjs` /
`piRuntimeNodeInstall.test.mjs` / `updateServiceE2E.test.mjs` / `createAutoUpdater.test.mjs` 等）。
本次刻意没有做这个重构。

### 3. 应用身份（appId / productName）保持上游

`package.json` 的 `build.appId` 仍是 `com.ayuayue.pi-desktop`，`productName` 仍是 `PiDeck`。

后果：本 fork 打的包与原版 PiDeck 会**互相覆盖安装**、共用 `%APPDATA%/pi-desktop`
数据目录与单实例锁（同版本互斥）。如果不希望这样，需要同时改：

- `package.json` → `build.appId`（如 `com.coo0.pi-desktop`）
- `src/main/index.ts` → `app.setAppUserModelId(...)` 的正式版分支（当前是 `com.ayuayue.pi-desktop`）
- `src/main/portableUserData.ts` → `PACKAGED_USER_DATA_NAME`（当前是 `"pi-desktop"`）

改 `userData` 目录名会导致读不到旧配置，属破坏性变更。

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
