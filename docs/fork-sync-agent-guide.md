# Agent 操作手册：把上游 main 合并到 custom 并发版

> 这份文档是给 **AI agent** 执行的作业指导书，也是人工操作的 checklist。
> 配套的自动化实现是 `scripts/sync-upstream.mjs`（逻辑唯一事实来源）与
> `.github/workflows/fork-sync-upstream.yml`（定时执行）。
> 策略细节见 `docs/fork-conflict-policy.md`；fork 背景见 `FORK.md`。

## 0. 核心原则（先读，再动手）

1. **custom 优先。** custom 上的新增功能与 bug 修复是主体，冲突时默认保留 custom。
2. **不静默丢改动。** 禁止 `-X ours` / `-X theirs` 蒙过去（`AGENTS.md` 硬性规定）。
   取任何一边都必须是**显式决定**，且取 custom 时要记录「放弃了哪些上游改动」。
3. **宁可停下，不可猜。** 无法安全判定 → 中止，不推送，写报告交人工。
4. **门禁是最终裁判。** typecheck + 全量测试全绿才算合并成功；红了就回退，不推。

## 1. 前置检查

```bash
cd <repo>
git status --porcelain          # 必须干净（脚本用临时 worktree，但先确认无未提交改动）
git remote -v                   # 需要 upstream → https://github.com/ayuayue/PiDeck.git
git fetch upstream main --tags
```

若缺 upstream：

```bash
git remote add upstream https://github.com/ayuayue/PiDeck.git
```

## 2. 执行同步（推荐：一条命令）

```bash
npm run sync:upstream                 # 合并 custom + 重新生成 + 门禁 + 推送
npm run sync:upstream -- --dry-run    # 只看会并入什么，不合并
npm run sync:upstream -- --no-push    # 合并 + 门禁，但不推送（本地验证）
```

脚本做的事（按序）：

```
1. 临时 worktree 检出 custom（不动当前工作区）
2. merge --no-ff upstream/main
3. 冲突 → 按 classifyConflict() 逐文件处置（见第 3 节）
4. 重新生成生成物（generate-* 脚本）
5. npm run typecheck        失败 → 中止，不推送
6. npm run test:serial      失败 → 中止，不推送
7. git push origin HEAD:custom
```

## 3. 冲突处置规则（`classifyConflict`）

**关键前提**：git 只在**双方都改了同一处**时才冲突。所以**每个冲突文件都必然含
custom 的改动**——此时取上游等于静默删掉 custom 的功能。这就是默认取 custom 的原因。

| 判定 | 文件 | 处置 | 理由 |
|---|---|---|---|
| `package-json` | `package.json` | **字段级合并** | 保留 custom 的 `build.publish.owner` / `build.appId` / `repository` / `homepage` / `bugs`，其余（version / deps / scripts）取上游；`scripts` 以上游为底并补回 custom 独有键 |
| `regenerate` | 各 `*-manifest.json`、`pi-ai-catalog.json`、`announcements.json` | 取上游后**重新生成** | 生成器会读 custom 的源文件，custom 内容不会丢；禁止手工解 |
| `patch` | `App.tsx`、`ComposerComponents.tsx` | 取上游 **+ 重放 custom 补丁** | 上游会持续重构这两个组装层，整文件取 custom 会连带回退上游重构；重放补丁能**双方都保留**（优于整文件取边） |
| `ours` | 其余全部（含默认） | 取 **custom** | 冲突必然含 custom 改动，不能丢 |

`patch` 重放后若仍有冲突块，用**并集规则**（`resolveConflictUnion`），只接受两类
可证明安全的形态，其余交人工：

1. **整块都是 import** → 按模块合并 specifier 取并集（import 超集永远是合法 TS）；
2. **add/add（diff3 base 为空）** → 两侧各自新增，**整块拼接**（不可按行去重，
   否则会揉坏 `useEffect(() => {` 这类成对结构行——这个 bug 曾被 typecheck 拦下）；
3. 一侧是另一侧超集 → 取超集；
4. 其余 → 返回 null，**不猜**。

## 4. 复核「放弃的上游改动」（**必做**）

取 custom 的代价是放弃上游对该文件的改动。脚本会把清单与上游侧内容写入
`fork-sync-conflict-report.json`（`reason: "custom-priority-applied"`）。

**必须人工确认两件事**：

1. 上游是不是**修了同一个 bug**？是 → 应当吸收上游的实现，而不是保留 custom 旧版。
2. 上游有没有**改到 custom 依赖的接口**（函数签名、类型、atom 名）？有 → 需要在
   custom 侧跟进适配，否则门禁会红。

```bash
cat fork-sync-conflict-report.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('原因:',r.reason);(r.files||[]).forEach(f=>console.log(' -',f))})"
```

## 5. 失败时的处理

| 症状 | 原因 | 处置 |
|---|---|---|
| 报告 `unresolved-conflicts` | 冲突块不在并集规则内（双方真改了同一处） | 手动解：看报告里的冲突块原文，改完 commit 后**重跑**；`rerere` 会记住解法，下次自动重放 |
| 报告 `typecheck-failed` | 并集解错了 / 上游改了接口 | 看报告尾部输出，修好重跑 |
| 报告 `tests-failed` | 行为回归 | 同上 |
| 报告 `custom-priority-applied` | 正常（custom 优先），但**必须复核**第 4 节 | 不是错误，但要确认没漏掉上游的 bug 修复 |

失败时 `custom` **未被修改**（`merge --abort`），可以安全重试。

## 6. 发版（打 tag 自动出包）

`fork-release.yml` 支持 **tag push 触发**（`v*`）：

```bash
# 1) 先把版本写进 package.json（必须与 tag 一致，否则 CI 会硬失败）
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='0.7.7-custom.1';
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
"
git add package.json && git commit -m "chore: release v0.7.7-custom.1"

# 2) 打 tag 并推送 → 自动触发 macOS + Windows 构建
git tag v0.7.7-custom.1
git push origin custom --follow-tags
```

产物是 **draft Release**，到 GitHub Releases 页面确认后点 **Publish**。

### 版本号约定（重要）

- 格式 `X.Y.Z-custom.N`（如 `v0.7.7-custom.1`），**避开上游 tag 命名空间**；
- `package.json` 的 `version` 必须与 tag **完全一致**。为什么：electron-updater 按
  预发布 channel 匹配 release（当前版本 `0.7.7-custom.1` → channel=`custom` →
  只认 tag 里带 `-custom` 的 release）。不一致会导致用户端**永远检测不到更新**。
  workflow 里有硬校验，不一致直接失败。
- 递增 `N`：`-custom.1` → `-custom.2`（semver 语义：同号 `-custom.2` 高于 `-custom.1`）。

### 也可以手动触发

Actions → `Fork Release` → Run workflow，可指定 tag / ref / 平台 / 是否 draft。

## 7. 本仓库的分支模型

| 分支 | 同步方式 | 冲突 |
|---|---|---|
| `main` | 一行 fast-forward（`git push origin upstream/main:main`），由 CI 的 `sync-main` job 每日执行 | 不涉及（git 拒绝非 ff 推送，main 被污染会失败变红） |
| `custom` | 合并 `upstream/main` + 策略解冲突（本文档） | 按第 3 节 |

**默认分支是 `custom`**（GitHub 的 `schedule` / `workflow_dispatch` 只读默认分支上的
workflow 文件）。不要把默认分支改回 `main`，否则两个同步都会停。

## 8. 手动解冲突的完整流程（脚本解不了时）

```bash
# 1. 起一个临时 worktree，别污染当前工作区
git worktree add --detach /tmp/pideck-merge custom
cd /tmp/pideck-merge
git merge upstream/main            # 会停在冲突

# 2. 看冲突
git diff --name-only --diff-filter=U
git diff                           # 或直接在编辑器里看 <<<<<<< 标记

# 3. 逐文件决策（按第 3 节规则）
#    取 custom： git checkout --ours -- <file> && git add <file>
#    取上游：   git checkout --theirs -- <file> && git add <file>
#    手工解：   编辑后 git add <file>

# 4. 提交 + 校验
git commit --no-edit
npm run typecheck
npm run test:serial

# 5. 推送（回到主仓库推送 worktree 里的 HEAD）
git push origin HEAD:custom
cd - && git worktree remove --force /tmp/pideck-merge
```

解完后 **`rerere` 会记住这次解法**，下次遇到同一冲突自动重放：

```bash
git config rerere.enabled true      # 一次性
git config rerere.autoupdate true
```

## 9. 禁止事项

- ❌ `git merge -X ours` / `-X theirs` 静默吞掉对方改动；
- ❌ `git push --force` 到 `main` 或 `custom`；
- ❌ 手工编辑 `resources/*-manifest.json` 等生成物（用生成脚本）；
- ❌ 在门禁红的情况下推送（会绕过唯一的自动裁判）；
- ❌ 手工编辑 `scripts/fork-patches/*.patch`（每次同步成功会自动重建，改了会被覆盖）。
