import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/custom-release.yml"), "utf8");
const matrix = workflow.match(/^[\t ]*matrix:\s*\n[\s\S]{0,2400}?^[\t ]*runs-on:/m)?.[0] ?? "";
const matrixInclude = matrix.match(/^[\t ]*include:\s*\n([\s\S]*?)(?=^[\t ]*runs-on:)/m)?.[1] ?? "";
const matrixEntries = [...matrixInclude.matchAll(/^([\t ]*)-[\t ]+[\s\S]*?(?=^\1-[\t ]+|(?![\s\S]))/gm)].map((match) => match[0]);
const permissions = workflow.match(/^permissions:\s*\n([\s\S]*?)(?=^[^\t \r\n][^:\r\n]*:\s*$)/m)?.[1] ?? "";
const permissionLines = permissions
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter(Boolean);

function matrixEntry(name) {
	return matrix.match(new RegExp(`^[\\t ]*-[\\t ]+name:\\s*${name}\\s*$[\\s\\S]{0,1200}?(?=^[\\t ]*-[\\t ]+name:|^[\\t ]*runs-on:)`, "m"))?.[0] ?? "";
}

function uploadFiles(name) {
	const files = matrixEntry(name).match(/^[\t ]*upload_files:\s*\|\s*\n([\s\S]*)/m)?.[1] ?? "";
	return files
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

test("custom release workflow: 仅由 custom-v 标签推送触发", () => {
	assert.match(workflow, /^on:\s*\n[\t ]+push:\s*\n[\t ]+tags:\s*\n[\t ]+-\s*"custom-v\*"\s*\n\s*permissions:/m);
});

test("custom release workflow: 矩阵仅构建三个目标平台", () => {
	assert.deepEqual(
		matrixEntries.map((entry) => entry.match(/^[\t ]*-[\t ]+name:\s*([^\r\n]+?)\s*$/m)?.[1] ?? ""),
		["Windows x64", "macOS x64", "macOS arm64"],
	);
});

test("custom release workflow: Windows x64 使用 Windows runner 和明确 x64 打包命令", () => {
	assert.match(matrixEntry("Windows x64"), /os:\s*windows-latest[\s\S]{0,240}?command:\s*npm run build && npx electron-builder --win nsis portable zip --x64 --publish never/);
});

test("custom release workflow: macOS x64 使用 macOS runner 和明确 x64 打包命令", () => {
	assert.match(matrixEntry("macOS x64"), /os:\s*macos-latest[\s\S]{0,240}?command:\s*npm run build && npx electron-builder --mac dmg zip --x64 --publish never/);
});

test("custom release workflow: macOS arm64 使用 macOS runner 和明确 arm64 打包命令", () => {
	assert.match(matrixEntry("macOS arm64"), /os:\s*macos-latest[\s\S]{0,240}?command:\s*npm run build && npx electron-builder --mac dmg zip --arm64 --publish never/);
});

test("custom release workflow: Windows sidecar 在构建后、上传前打包两个架构", () => {
	assert.match(workflow, /name:\s*Build packages[\s\S]{0,800}?name:\s*Pack DSH runner Node sidecar[\s\S]{0,160}?if:\s*matrix\.platform\s*==\s*'windows'[\s\S]{0,160}?pack-dsh-runner-node\.mjs\s+--arch\s+x64\s+&&\s+node\s+scripts\/pack-dsh-runner-node\.mjs\s+--arch\s+arm64[\s\S]{0,320}?name:\s*Upload release assets/);
});

test("custom release workflow: 顶层权限仅为 contents read", () => {
	assert.deepEqual(permissionLines, ["contents: read"]);
});

test("custom release workflow: 同一标签的发布串行且不取消运行中的任务", () => {
	assert.match(workflow, /^concurrency:\s*\n[\t ]+group:\s*custom-release-\$\{\{\s*github\.ref\s*\}\}\s*\n[\t ]+cancel-in-progress:\s*false\s*\n/m);
});

test("custom release workflow: PAT 按推送标签创建普通 Release 并忽略未匹配资产", () => {
	assert.match(workflow, /uses:\s*softprops\/action-gh-release@v2[\s\S]{0,160}?token:\s*\$\{\{\s*secrets\.RELEASE_PAT\s*\}\}[\s\S]{0,160}?tag_name:\s*\$\{\{\s*github\.ref_name\s*\}\}[\s\S]{0,160}?fail_on_unmatched_files:\s*false[\s\S]{0,160}?draft:\s*false[\s\S]{0,160}?prerelease:\s*false/);
});

test("custom release workflow: Windows 上传安装包、更新元数据和 runner sidecar", () => {
	assert.deepEqual(uploadFiles("Windows x64"), ["release/*.exe", "release/*.msi", "release/*.zip", "release/*.blockmap", "release/latest*.yml", "dist-runtime/dsh-runner-node/*.zip", "dist-runtime/dsh-runner-node/dsh-runner-node-releases.json"]);
});

test("custom release workflow: 两个 macOS 架构仅上传 dmg 和 zip", () => {
	assert.deepEqual(
		[uploadFiles("macOS x64"), uploadFiles("macOS arm64")],
		[
			["release/*.dmg", "release/*.zip"],
			["release/*.dmg", "release/*.zip"],
		],
	);
});

test("custom release workflow: 发布 action 使用矩阵上传清单", () => {
	assert.match(workflow, /files:\s*\$\{\{\s*matrix\.upload_files\s*\}\}/);
});

test("custom release workflow: 不包含 Linux 或独立 runtime 资产 job", () => {
	assert.doesNotMatch(workflow, /linux|^[\t ]{2}(?:pack-dsh-runtime|pack-dsh-runner-node):/im);
});
