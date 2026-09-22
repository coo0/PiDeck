/**
 * 系统字体枚举（src/main/fonts/SystemFonts.ts）。
 *
 * 重点守护 name 表解析：族名必须取字体文件里的真实族名（nameID 16 → 1），
 * 因为 CSS font-family 按真实族名匹配，用文件名推断会让下拉里带样式后缀的条目
 * 选中后不生效（实测 `HackNerdFont-BoldItalic.ttf` 的真实族名是 `Hack Nerd Font`）。
 *
 * 这里用手工构造的 SFNT 字节验证解析（不依赖机器上恰好装了哪个字体），
 * 另有真实文件冒烟：macOS/Linux 上若系统字体目录可用，则断言能解析出非空族名。
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseNameTable, locateNameTable, fontFamilyFromFileName, readFontFamilyName, listSystemFontFamilies } = loadTsCommonJs("src/main/fonts/SystemFonts.ts", {
	stubs: { electron: { app: { getPath: (name) => (name === "home" ? (process.env.HOME ?? "/tmp") : "/tmp") } } },
});

/** 构造一个最小 SFNT：表目录 + name 表（platform/language/nameID 可指定）。 */
function buildSfnt({ nameIds, platformId = 3, languageId = 0x0409, includeNameId16 = true } = {}) {
	const records = [];
	const strings = [];
	let stringOffset = 0;
	// 需要的 nameID：16（Typographic Family）优先，1（Family）其次
	const wanted = includeNameId16 ? [16, 1] : [1];
	for (const nameId of wanted) {
		const value = nameIds[nameId];
		if (value === undefined) continue;
		let bytes;
		if (platformId === 3) {
			bytes = Buffer.from(value, "utf16le").swap16();
		} else {
			bytes = Buffer.from(value, "latin1");
		}
		records.push({ platformId, languageId, nameId, length: bytes.length, offset: stringOffset });
		strings.push(bytes);
		stringOffset += bytes.length;
	}
	const nameTableLength = 6 + records.length * 12 + stringOffset;
	const nameTable = Buffer.alloc(nameTableLength);
	nameTable.writeUInt16BE(0, 0); // format
	nameTable.writeUInt16BE(records.length, 2);
	nameTable.writeUInt16BE(6 + records.length * 12, 4); // stringOffset
	records.forEach((record, index) => {
		const base = 6 + index * 12;
		nameTable.writeUInt16BE(record.platformId, base);
		nameTable.writeUInt16BE(0, base + 2); // encodingId
		nameTable.writeUInt16BE(record.languageId, base + 4);
		nameTable.writeUInt16BE(record.nameId, base + 6);
		nameTable.writeUInt16BE(record.length, base + 8);
		nameTable.writeUInt16BE(record.offset, base + 10);
	});
	let cursor = 6 + records.length * 12;
	for (const bytes of strings) {
		bytes.copy(nameTable, cursor);
		cursor += bytes.length;
	}
	// 文件 = 12 字节头部 + 表目录(1 项) + name 表
	const file = Buffer.alloc(12 + 16 + nameTable.length);
	file.writeUInt32BE(0x00010000, 0);
	file.writeUInt16BE(1, 4); // numTables
	file.write("name", 12, "latin1");
	file.writeUInt32BE(12 + 16, 12 + 8); // name 表偏移
	file.writeUInt32BE(nameTable.length, 12 + 12);
	nameTable.copy(file, 12 + 16);
	return file;
}

test("typographic family name (nameID 16) wins over family (nameID 1)", () => {
	const file = buildSfnt({ nameIds: { 16: "Hack Nerd Font", 1: "Hack Nerd Font Mono" } });
	const located = locateNameTable(file);
	assert.ok(located, "name table must be located");
	assert.equal(parseNameTable(file.subarray(located.offset, located.offset + located.length)), "Hack Nerd Font");
});

test("falls back to family name (nameID 1) when nameID 16 is absent", () => {
	const file = buildSfnt({ nameIds: { 1: "Courier New" }, includeNameId16: false });
	const located = locateNameTable(file);
	assert.equal(parseNameTable(file.subarray(located.offset, located.offset + located.length)), "Courier New");
});

test("mac platform records (latin1) are decoded as well", () => {
	const file = buildSfnt({ nameIds: { 1: "Menlo" }, platformId: 1, languageId: 0, includeNameId16: false });
	const located = locateNameTable(file);
	assert.equal(parseNameTable(file.subarray(located.offset, located.offset + located.length)), "Menlo");
});

test("malformed / truncated input yields null instead of throwing", () => {
	assert.equal(parseNameTable(Buffer.alloc(0)), null);
	assert.equal(locateNameTable(Buffer.alloc(4)), null);
	assert.equal(locateNameTable(Buffer.from("not-a-font-at-all")), null);
});

test("font family from file name strips style suffixes as a last resort", () => {
	assert.equal(fontFamilyFromFileName("HackNerdFont-BoldItalic.ttf"), "HackNerdFont");
	assert.equal(fontFamilyFromFileName("Arial Bold Italic.ttf"), "Arial");
	assert.equal(fontFamilyFromFileName("Apple Braille.ttf"), "Apple Braille");
});

test("hidden system fonts (leading dot / @-alias) are filtered out", async () => {
	const families = await listSystemFontFamilies({ refresh: true });
	if (families.length === 0) return; // 无字体目录的环境：枚举为空已由 UI 侧兜底
	assert.equal(families.filter((name) => name.startsWith(".") || name.startsWith("@")).length, 0, "macOS 私有族名（.LastResort / .SF NS Mono）与本地化别名（@宋体）不应出现在下拉里");
});

test("reads a real installed font when the platform font directory is present", async (context) => {
	const dirs = process.platform === "darwin" ? ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental"] : process.platform === "win32" ? [join(process.env.WINDIR ?? "C:\\Windows", "Fonts")] : ["/usr/share/fonts"];
	let candidate;
	for (const dir of dirs) {
		try {
			const entries = await readdir(dir);
			const file = entries.find((name) => /\.(ttf|otf|ttc|otc)$/i.test(name));
			if (file) {
				candidate = join(dir, file);
				break;
			}
		} catch {
			// 该目录不存在：换下一个
		}
	}
	if (!candidate) {
		context.skip("no system font file found");
		return;
	}
	const family = await readFontFamilyName(candidate);
	// 解析失败允许回退到文件名，但绝不能是空/带控制字符的名称
	assert.ok(typeof family === "string" && family.trim().length > 0, `expected a family name for ${candidate}`);
	assert.doesNotMatch(family, /[\u0000-\u001f]/);
});
