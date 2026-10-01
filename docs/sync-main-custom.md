# 将 `main` 同步到 `custom`

本流程把 `main` 的更新合入 `custom`，同时完整保留 `custom` 上新增的业务功能和 bug 修复。同步发生在临时 worktree 中；工作区、分支和远端状态必须可追溯。

## 目标与原则

- `main` 是待吸收的来源，`custom` 是保留 custom 能力的目标；冲突不能以整文件覆盖 custom。
- custom 新增功能、用户修复和 fork 身份配置不得被上游覆盖。每个冲突都要人工判断并记录取舍。
- 上游若修复了同一个 bug，应把两边的修复合并成一个正确实现；不能因为“custom 优先”而保留已知旧实现。
- 生成文件通过生成器重建，不手工拼接；组装层取上游后重放 custom 补丁。
- 禁止 `git merge -X ours`、`git merge -X theirs`，以及 `git checkout --ours`、`git checkout --theirs` 等静默丢改动的命令。无法确定时停止，不推送，保留现场。
- 本文档中的合并、提交、推送、创建备份分支命令都需要维护者确认后执行。

## 同步前检查

先在仓库根目录执行只读检查；确认工作区干净、两个本地分支存在，并通过 `git worktree list` 确认 `custom` 未被任何 worktree 占用：

```bash
git status --short
git branch --show-current
git branch --list main custom
git worktree list
git remote -v
```

若 `git status --short` 有输出，先处理或另开工作区，不要带着未提交改动同步。重点检查 `git worktree list`：

- 若当前目录检出 `custom`，只有在工作区干净且维护者明确确认后，才可先切换到 detached HEAD，再创建临时 worktree：

  ```bash
  git switch --detach
  ```

  也可以改用另一个未占用 `custom` 的仓库或 worktree 执行同步。
- 若 `custom` 已被其他 worktree 占用，停止创建新的临时 worktree；应复用该 worktree，或在确认其工作区干净且不再需要后释放它，不能强行创建。

以下命令会创建可回退的本地备份引用，执行前需确认备份名未存在：

```bash
BACKUP="backup/custom-before-main-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP" custom
```

推荐使用临时 worktree，避免切换正在工作的目录。仅在前述 `git worktree list` 已确认 `custom` 未被占用后执行：

```bash
WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/pideck-custom-sync.XXXXXX")"
git worktree add "$WORKTREE" custom
cd "$WORKTREE"
```

确认 `WORKTREE` 路径和备份引用正确后再继续。同步结束或中止后，不要删除含冲突的 worktree；只有确认成功且不需要现场时才执行：

```bash
git worktree remove "$WORKTREE"
```

## Fetch 与合并

远端优先使用 `upstream`。如果仓库没有 `upstream`，不要猜远端地址：可以使用已有的 `origin` 作为 `main` 来源，或由维护者确认后添加正确的 upstream：

```bash
# 有 upstream 时
REMOTE=upstream
git fetch "$REMOTE" main --tags

# 没有 upstream、且确认 origin 的 main 就是来源时
REMOTE=origin
git fetch "$REMOTE" main --tags
```

如确实需要添加 upstream，URL 必须由维护者确认后执行：

```bash
git remote add upstream <已确认的上游仓库 URL>
git fetch upstream main --tags
REMOTE=upstream
```

再次核对来源提交和目标分支，再执行合并（需要明确确认）：

```bash
git log --oneline --decorate -5 "$REMOTE/main"
git log --oneline --decorate -5 custom
git merge --no-ff "$REMOTE/main"
```

发生冲突时不要提交，也不要推送；先按下节处理。若决定中止且现场已经记录，可在该 worktree 执行 `git merge --abort`。不确定是否可安全中止时，先保留 worktree 和状态输出。

## 冲突处理顺序

1. 记录清单和完整状态：

   ```bash
   git status
   git diff --name-only --diff-filter=U
   git diff > /tmp/pideck-custom-sync-conflicts.diff
   ```

2. 逐个文件阅读冲突块、共同祖先和双方意图。每个冲突都必须通过编辑器手工合并并运行 `git add <file>`；不要使用 `--ours`/`--theirs` 选边。
3. 先处理身份与混合配置：`package.json` 必须按字段合并（见下节）。custom 的 `publish`、`appId`、仓库链接和 custom 独有配置不能被覆盖；依赖与上游新增脚本则要检查兼容性。
4. 处理生成物：对 manifest、catalog、公告等冲突，不手工解冲突，按规则保留源文件后重新运行生成命令（见下节）。
5. 处理组装层：`src/renderer/src/App.tsx`、`src/renderer/src/components/session/ComposerComponents.tsx` 等上游持续重构的文件，应以上游结构为基础，重放 custom 补丁和功能接线；不能整文件取任一边。补丁重放后仍有语义冲突时逐块合并，无法证明两边都能保留则停止。
6. 其余冲突默认保留 custom 的功能和修复，同时逐项复核上游是否有同一 bug 修复或接口变化；需要吸收的上游改动必须显式改写进 custom 版本。
7. 清除所有冲突标记后检查：

   ```bash
   git diff --check
   git diff --name-only --diff-filter=U
   ```

   未解决文件清单必须为空，且所有 custom 改动都已可在 diff 中解释。遇到不确定语义、接口不匹配或无法安全重放补丁时，停止并保留 worktree，不提交、不推送。

## 特殊文件处理

### `package.json`

禁止整文件取一边，按字段检查并合并：

- `build.publish.owner`、`build.appId`、`repository`、`homepage`、`bugs` 保留 custom 的 fork 身份和发布坐标。
- `version`、`dependencies`、`devDependencies` 以 `main` 为基线，再确认 custom 必需依赖仍存在。
- `scripts` 以双方并集为目标：保留 custom 独有脚本，同时纳入 main 新增脚本，确认无同名语义冲突。
- 同步 `package-lock.json` 时不要手工编辑锁文件；在依赖字段确定后使用项目规定的 npm 命令重建并检查 diff。

### 生成文件

以下文件冲突时不要手工拼接：`resources/extensions/extensions-manifest.json`、`resources/pi-ai-catalog.json`、`resources/pi-ai-catalog.manifest.json`、`resources/prompts/prompts-manifest.json`、`resources/skills/skills-manifest.json`、`announcements.json`。先确认对应源文件包含 custom 内容，再运行：

```bash
npm run generate:pi-ai-catalog
npm run generate:extensions-manifest
npm run generate:prompts-manifest
npm run generate:skills-manifest
npm run build:announcements
```

生成结果必须纳入待提交 diff；不要直接修改生成 JSON。必要时运行对应 `check:*` 命令确认无漂移。

### 组装层

对 `App.tsx`、`ComposerComponents.tsx` 等文件，先理解 main 的重构，再把 custom 的 hooks、atom、组件和事件接线逐项重放。检查 custom 功能的入口、状态生命周期和类型接口都仍然存在；不能用“保留整份 custom 文件”代替合并。

## 冲突后验证

在冲突全部解决且生成物已重建后，从 worktree 根目录运行：

```bash
npm ci
npm run typecheck
npm run test:serial
npm run check:format
npm run check:pi-ai-catalog
npm run check:extensions-manifest
npm run check:prompts-manifest
npm run check:skills-manifest
npm run check:announcements
```

`npm ci` 会改写依赖安装目录，确认 lockfile 没有意外变更。按改动范围补充相关测试；核心门禁失败时不要提交或推送，先修复并重新执行完整检查。生成检查失败时回到源文件和生成命令，不手工改产物。

## 提交与推送前核对

提交和推送均需维护者再次确认。先查看完整差异、状态和提交范围：

```bash
git status --short
git diff --stat custom...HEAD
git diff --check
git diff custom...HEAD
```

确认以下事项后才提交：没有冲突标记或未跟踪的临时文件；custom 功能和 bug 修复仍在；身份字段正确；生成物由脚本产生；验证命令全部通过。然后执行：

```bash
git add <已审阅的文件>
git commit -m "Merge main into custom"
git status --short
git log --oneline --decorate -2
```

提交后先核对提交内容，再按维护者确认的远端推送：

```bash
git show --stat --oneline HEAD
git status --short
REMOTE=origin   # 由维护者确认；不要默认假设远端
git push "$REMOTE" HEAD:custom
```

推送前应确认目标远端和分支没有变化；禁止 force push。若推送失败，保留提交、worktree 和状态，不要为了“重试”改写历史。

## 失败或不确定时

停止当前步骤，保留 worktree、备份引用、`git status`、冲突 diff 和命令输出；不要运行 `git merge --abort`、删除 worktree 或推送，除非先确认这些操作不会丢失现场。将未决文件、冲突块、已通过/失败的检查和需要人工决定的取舍记录下来，交由维护者处理。恢复前先重新核对当前分支、远端 HEAD 和备份引用。
