# Fork 冲突策略（自动同步的依据）

本文件是 `scripts/sync-upstream.mjs` 与 `.github/workflows/fork-sync-upstream.yml` 的
**唯一决策依据**：自动同步遇到冲突时，按这里的分区规则决定取哪一边。它同时是人工解冲突
的 checklist。

上游规则见 `AGENTS.md`（合并上游后以上游版本为主体）；fork 的分支模型见 `FORK.md`。

## 0. 原则

1. **custom 优先**。custom 的新增功能与 bug 修复是主体，冲突时默认保留 custom。
2. **绝不静默吞改动**。`AGENTS.md` 明令禁止 `-X ours` / `-X theirs` 蒙过去；本策略用
   「显式分类 + 记录被放弃的一侧」替代无脑选边，且取 custom 时必须留下复核清单。
   策略未覆盖的冲突一律**停下并写报告**，不推送。
3. **上游修复优先**。同一处 bug 上游也修了 → 应收上游实现（复核清单里确认，见 D 区）。
4. **生成物永不手工解**。各 `*-manifest.json`、`pi-ai-catalog.json`、`announcements.json`
   冲突时取上游后**重新生成**（见第 3 节）。
5. **fork 身份文件以 fork 为准**（见第 2 节 A 区）。

## 1. 分区（自动同步的判定表）

### A 区：fork 身份与坐标 —— **取 fork（ours）**

这些文件承载「这是 coo0 的 fork」这一事实，取上游会退回上游身份。

| 文件 | 为什么取 fork |
|---|---|
| `FORK.md` | 上游无同名文件，纯 fork 文档 |
| `docs/fork-conflict-policy.md` | 本文件，同上 |
| `.githooks/pre-push` | 固定 `PI_DECK_SKIP_ATOMGIT=1`，不向上游 AtomGit 写入 |
| `package.json` → `build.publish.owner` | 必须是 `coo0`（应用更新指向 fork 的 Release） |
| `package.json` → `appId` | 刻意保持 `com.ayuayue.pi-desktop`（见 FORK.md 第 3 节） |
| `src/main/update/releaseRepo.ts` | 应用更新坐标 = `coo0/PiDeck` |
| `src/shared/updateSources.ts` | `APP_UPDATE_REPO_*`（coo0）与内容源（ayuayue）拆分 |
| `src/renderer/src/components/app/AboutPopover.tsx` 等展示链接 | UI 指向 `github.com/coo0/PiDeck` |
| `src/main/ipc/systemIpc.ts` 的 `releasesUrl` 兜底 | 同上 |

> 注意：`package.json` 是**混合文件**——`build.publish` / `appId` 属 A 区取 fork，但
> `version`、`dependencies`、`scripts` 必须跟上游。所以 `package.json` 冲突**不能整文件取边**，
> 必须逐 hunk 判（脚本对 `package.json` 走「保留 fork 的 publish/appId + 取上游其余」特例）。

### B 区：上游所有的组装层 —— **取上游 + 重放补丁**

历史冲突 100% 集中在这些 4000+ 行的组装层文件（`AGENTS.md` 的 size debt）。

| 文件 | fork 在此改了什么 |
|---|---|
| `src/renderer/src/App.tsx` | 消耗动画开关 atom 镜像、自定义 hooks 接线 |
| `src/renderer/src/components/session/ComposerComponents.tsx` | composer 模型 chip / 底栏相关 |

规则：**取上游版本**，再用 `scripts/fork-patches/<basename>.patch` 重放 fork 改动。
补丁重放后若仍有冲突，按「并集规则」自动解（见下）；解不了 → 停下开 issue。

补丁在**每次成功同步后自动重建**（`upstream/main..HEAD` 的差异），因此会跟着上游演进。
**不要手工编辑补丁**：改了会在下次同步被覆盖；要让补丁变化，就改源码再跑一次同步。

#### 并集规则（自动解冲突的唯一依据）

只接受两类**可证明安全**的形态，其余一律交人工：

1. **整个冲突块都是具名 import** → 按模块合并，specifier 取并集。
   （import 的超集永远是合法 TS，本仓库 `noUnusedLocals=false`。）
2. **add/add（diff3 base 为空）** → 两侧各自新增，整块拼接保留双方（不按行去重：
   两侧结构行如 `useEffect(() => {` 相同但各自成对，去重会揉坏代码）。

其余（双方真的改了同一处，如函数体语义不同）→ 不猜，开 issue。

### C 区：fork 自有能力 —— **取 fork（ours）**

新增文件（上游无同名文件）天然不冲突；以下是**同名但被 fork 修改**、且改动属于自有能力的文件。

| 文件 | fork 能力 |
|---|---|
| `resources/extensions/pi-deck-retry-no-body.ts` | 补两类 pi 重试名单漏掉的瞬态故障 |
| `src/main/config/userUsageProbes.ts`、`src/renderer/src/config/UsageProbeConfigDialog.tsx` | 用量探针迁移与输入区显示 |
| `src/main/terminal/*`、`src/renderer/src/components/terminal/*`、`src/renderer/src/terminalThemes.ts`、`src/renderer/src/terminalDockState.ts`、`src/shared/types/terminal.ts` | 终端 GPU 渲染（WebGL2）+ 终端设置页 |
| `src/renderer/src/components/session/ModelEffortPopover.tsx`、`EffortSlider.tsx`、`ModelPickerBody.tsx`、`SessionContextMeter.tsx`、`src/renderer/src/utils/effortColors.ts`、`effortSlider.ts`、`modelEffortPopover.ts`、`contextSpend.ts` | 底栏模型档位控件 + 上下文圆环 |
| `src/renderer/src/hooks/useContextSpendEffects.ts` | 消耗动画 |
| `src/renderer/src/utils/settingsFieldAnchors.ts`、`components/app/settings/TerminalTab.tsx`、`settingsTabLayout.ts` | 设置页锚点与终端分页 |

> C 区判定优先级高于 B 区：同名文件若同时命中两区，按**文件级**归属，不混。

### D 区：其余全部 —— **取 custom（ours，默认）**

不在 A/B/C 区、也不是生成物的其余文件，冲突时**默认取 custom**。

**为什么默认是 custom 而不是上游**：git 只在**双方都改了同一处**时才冲突。因此
每一个冲突文件都必然包含 custom 的改动——此时取上游等于静默删掉 custom 的功能，
与「custom 新增功能与 bug 修复优先」的原则相悖，也是 `AGENTS.md` 明禁的失败模式。

代价与配套：取 custom 意味着**放弃上游对该文件的改动**。脚本会把清单与上游侧内容
写入 `fork-sync-conflict-report.json`（`reason: "custom-priority-applied"`），**必须人工复核**
两件事：① 上游是否修了同一个 bug（是则应收上游实现）；② 上游是否改了 custom 依赖的
接口。随后由 typecheck + 全量测试门禁作第二道防线。

> 若某文件属于「上游持续重构 + custom 只加了少量东西」，不要把它放进 D 区，
> 而应放进 B 区（补丁重放）——那样能双方都保留。

### E 区：生成物 —— **取上游后重新生成**

`resources/extensions/extensions-manifest.json`、`resources/pi-ai-catalog.json`、
`resources/pi-ai-catalog.manifest.json`、`resources/prompts/prompts-manifest.json`、
`resources/skills/skills-manifest.json`、`announcements.json`。

冲突时取上游版本，然后**重新生成**（不要手工解）；同步脚本会在合并后自动跑生成命令。
生成结果与提交内容不一致时会补一次提交，仍不一致则视为同步失败。

## 2. 特例：`package.json`

不能整文件取边。按字段分：

| 字段 | 取 |
|---|---|
| `build.publish.owner` | fork（`coo0`） |
| `build.appId` | fork（`com.ayuayue.pi-desktop`） |
| `version` | 上游（fork 版本在发版时另行 bump） |
| `dependencies` / `devDependencies` | 上游 |
| `scripts` | 上游（fork 新增脚本放独立文件，不改这里的既有项） |
| `repository` / `homepage` / `bugs` | fork（指向 coo0，与展示链接一致） |

## 3. 生成物

冲突时取上游后**重新生成**（不要手工解）：

```bash
node scripts/generate-pi-ai-catalog.mjs
node scripts/generate-extensions-manifest.mjs
node scripts/generate-content-manifests.mjs --domain prompts
node scripts/generate-content-manifests.mjs --domain skills
node scripts/build-announcements.js
```

同步脚本会在合并后自动跑这些命令 + 依赖准备；生成结果与提交内容不一致则视为同步失败。
`package-lock.json` 不在 E 区，走 D 区默认（取 custom）；依赖一致性由合并后的
`npm ci` 与门禁把关。

## 4. 无法自动判定时

同步脚本**停止推送**、开 issue（`sync-upstream-conflict` 标签），issue 正文含：
冲突文件清单、冲突块原文、`git status` 摘要。人工处理完把解法交给 `rerere` 记住：

```bash
git config rerere.enabled true      # 一次性
git config rerere.autoupdate true
# 解完冲突并 commit 后，rerere 已把解法存进 .git/rr-cache，下次同冲突自动重放
```

## 5. 修改本策略

新增 C 区文件时，同时更新本节表格与 `scripts/sync-upstream.mjs` 的 `CONFLICT_POLICY`
常量（两者是同一份事实的两种表述，脚本内的常量才是运行时依据）。修改后跑
`node --test tests/forkSyncPolicy.test.mjs` 校验两处一致。
