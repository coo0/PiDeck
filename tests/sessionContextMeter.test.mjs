import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { formatPercent, formatCacheHitPercent } from "../src/renderer/src/components/session/TimelineFormat.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 与 sessionWidgetChips.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构。
function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const meterPath = "src/renderer/src/components/session/SessionContextMeter.tsx";
const meterSource = () => readFileSync(meterPath, "utf8");
const bottomBarSource = () => readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

function loadMeterHelpers() {
	return compile(meterPath, {
		react: {},
		"../../i18n": { t: (key) => key },
		"../../../../shared/types": {},
		"../../../../shared/compactFeedback": loadTsCommonJs("src/shared/compactFeedback.ts"),
		"../ui-shadcn/tooltip": {},
	});
}

test("formatTokens follows the dsh StatsLine compaction", () => {
	const { formatTokens } = loadMeterHelpers();
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1K");
	assert.equal(formatTokens(1234), "1.2K");
	// dsh 语义：≥100 直接取整（123.4K → 123K），不保留小数
	assert.equal(formatTokens(123400), "123K");
	assert.equal(formatTokens(999500), "1000K");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(128_000_000), "128M");
	assert.equal(formatTokens(12_400_000), "12.4M");
});

test("contextOccupancy keeps raw percent and recomputes zero percent from tokens", () => {
	const { contextOccupancy } = loadMeterHelpers();
	const occ = (state) => contextOccupancy(state);
	// vm 跨 realm 对象原型不同，deepEqual 会误判，按字段断言
	const fieldsOf = (state) => {
		const result = occ(state);
		return result === null ? null : `${result.percent}:${result.usedTokens}:${result.contextWindow}`;
	};
	// 常规：percent 保留原始精度（不再四舍五入成整数）
	assert.equal(fieldsOf({ contextPercent: 45.3, contextTokens: 57600, contextWindow: 128000 }), "45.3:57600:128000");
	// 超过 100 不封顶：pi 可能上报未封顶的原始值（缓存超窗），与 CLI footer 同口径
	assert.equal(fieldsOf({ contextPercent: 112, contextTokens: 100, contextWindow: 200 }), "112:100:200");
	// percent 上报为 0 但 tokens 非 0（pi/dsh 取整成 0 或未随 tokens 刷新）：
	// 按 tokens/window 重算，避免「占用 0% 但 ~408 / 1M」的自相矛盾展示
	const recomputed = occ({ contextPercent: 0, contextTokens: 408, contextWindow: 1_000_000 });
	assert.ok(recomputed !== null && Math.abs(recomputed.percent - 0.0408) < 1e-9);
	assert.equal(recomputed.usedTokens, 408);
	// tokens 为 0 时保持 0，不重算
	assert.equal(fieldsOf({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }), "0:0:1000");
	// 缺任一字段 = 无 capacity（模型切换瞬间），返回 null 不渲染
	assert.equal(occ(undefined), null);
	assert.equal(occ({ contextPercent: 50 }), null);
	assert.equal(occ({ contextTokens: 50, contextWindow: 100 }), null);
	assert.equal(occ({ contextPercent: 50, contextTokens: 50 }), null);
});

test("formatPercent keeps sub-percent precision for small context usage", () => {
	// 1M 窗口下 408 tokens ≈ 0.04%：整数四舍五入会显示成「0%」，必须保留有效数字
	assert.equal(formatPercent(0.0408), "0.04");
	assert.equal(formatPercent(0), "0");
	assert.equal(formatPercent(0.004), "0"); // 两位小数后仍为 0
	assert.equal(formatPercent(0.996), "1");
	assert.equal(formatPercent(1), "1");
	assert.equal(formatPercent(1.26), "1.3");
	assert.equal(formatPercent(9.94), "9.9");
	assert.equal(formatPercent(10), "10");
	assert.equal(formatPercent(45), "45");
	assert.equal(formatPercent(45.3), "45");
	assert.equal(formatPercent(100), "100");
});

/**
 * 2026-09 回归：输入框下方指标条的「缓存命中 100%」谎报满分。
 *
 * 实测会话 `2026-09-21T03-39-48-436Z_*.jsonl`（623 条 assistant 样本）：
 * 长会话命中率普遍落在 99.5%~99.98%，`Math.round` 把其中 **427 条**显示成 100%，
 * 而实际均 <100%（最新一条 input=646 / cacheRead=575360 = 99.8878%）。
 * pi CLI footer 的 `CH{n}%` 用 toFixed(1)，对应显示 99.9%。
 */
test("formatCacheHitPercent keeps one decimal like pi CLI footer (no false 100%)", () => {
	// 核心回归：99.8878% 不得显示成 100%
	assert.equal(formatCacheHitPercent(99.8878), "99.9%");
	assert.equal(formatCacheHitPercent(99.502), "99.5%");
	// 与 pi footer 同精度：真实 100% 仍显示 100.0%（不特殊处理）
	assert.equal(formatCacheHitPercent(100), "100.0%");
	assert.equal(formatCacheHitPercent(0), "0.0%");
	assert.equal(formatCacheHitPercent(87.98), "88.0%");
	// 边界：非有限值不展示（调用方跳过渲染）
	assert.equal(formatCacheHitPercent(null), undefined);
	assert.equal(formatCacheHitPercent(undefined), undefined);
	assert.equal(formatCacheHitPercent(Number.NaN), undefined);
	assert.equal(formatCacheHitPercent(Number.POSITIVE_INFINITY), undefined);
});

test("cache-hit display sites share one formatter (no Math.round / toFixed(0) drift)", () => {
	const statsLine = readFileSync("src/renderer/src/components/session/ComposerStatsLine.tsx", "utf8");
	const surfaces = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");

	// 三处（指标条 / 会话头部 chip / 悬停明细）必须都用共享 formatter
	assert.match(statsLine, /formatCacheHitPercent\(state\.cacheHitPercent\)/);
	assert.match(surfaces, /formatCacheHitPercent\(state\.cacheHitPercent\)/);
	assert.match(surfaces, /formatCacheHitPercent\(averageCacheHit\)/);
	// 旧的会谎报满分的写法必须彻底消失
	assert.doesNotMatch(statsLine, /Math\.round\(state\.cacheHitPercent\)/);
	assert.doesNotMatch(surfaces, /cacheHitPercent\??\.toFixed\?\.\(0\)/);
	assert.doesNotMatch(surfaces, /\$\{state\.cacheHitPercent\.toFixed\(1\)\}%/);
});

test("meter ring: 19px conic-gradient 甜甜圈，弧长画「剩余」（原型定稿几何）", () => {
	const source = meterSource();
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	// 组件侧：环身带 ctx-ring + 分档容器，把角度写成 CSS 变量
	assert.match(source, /className=\{`ctx-ring\$\{spend\.spendLabel !== null \? " animate-context-pulse" : ""\}`\}/);
	assert.match(source, /className=\{`ctx-ring-host flex h-7/);
	// 弧长 = 剩余（原型第 616 行：p * 3.6）；数字也是剩余口径
	assert.match(source, /contextLeftPercent\(context\?\.percent \?\? 0\)/);
	assert.match(source, /contextRingAngleDeg\(leftPercent\)/);
	assert.match(source, /"--ring-angle": `\$\{ringAngle\}deg`/);
	// 旧 14px SVG 描边环已彻底移除
	assert.doesNotMatch(source, /viewBox="0 0 14 14"/);
	assert.doesNotMatch(source, /const RADIUS = 5\.5/);
	assert.doesNotMatch(source, /CIRCUMFERENCE/);
	// 几何与色值归 CSS：19px + conic-gradient（角度变量驱动弧长）
	assert.match(css, /\.ctx-ring \{/);
	assert.match(css, /width: 19px;/);
	assert.match(css, /background: conic-gradient\(from -90deg, var\(--ring-a\) 0deg, var\(--ring-b\) var\(--ring-angle\), var\(--ctx-track\) var\(--ring-angle\) 360deg\);/);
	// 甜甜圈：内孔 inset 3px 填面板底色
	assert.match(css, /\.ctx-ring::after \{[\s\S]{0,120}?inset: 3px;[\s\S]{0,120}?background: var\(--color-bg-panel\);/);
	// 无 capacity 时渲染占位环常驻
	assert.match(source, /const percent = context\?\.percent \?\? 0;/);
	assert.match(source, /t\("sessionContext\.unavailable"\)/);
	// 打开期间挂 document 监听（外点/Escape 关闭）
	assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
	assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("meter ring styles live in @layer utilities, not @utility（@utility 不展开嵌套 &）", () => {
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	// 回归：这四条规则都依赖嵌套选择器（&::after / [data-level] / [data-warn]）。
	// Tailwind 的 @utility 会把嵌套的 & 原样写进产物，浏览器不认、静默失效——
	// 实测后果：环不变甜甜圈、五档全灰、预警弧永不出现（正是用户报的「没按文档改」）。
	// 必须放在 @layer utilities（参与嵌套处理，产物是真实 CSS）。
	assert.match(css, /@layer utilities \{/);
	assert.match(css, /\.ctx-ring \{/);
	assert.match(css, /\.ctx-ring::after \{/);
	assert.match(css, /\.ctx-ring-warnarc\[data-warn="true"\] \{/);
	assert.match(css, /\.ctx-ring-host\[data-level="critical"\] \{/);
	// 不得再退回 @utility ctx-ring*
	assert.doesNotMatch(css, /@utility ctx-ring/);
});

test("meter ring: 环外右侧数字 + ≤20% 预警斜线弧（原型定稿）", () => {
	const source = meterSource();
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	// 数字在环外右侧（不是环内），带 data-testid 便于取证
	assert.match(source, /data-testid="session-context-percent" className="ctx-ring-pct"/);
	assert.match(css, /\.ctx-ring-pct \{[\s\S]{0,220}?font-variant-numeric: tabular-nums;/);
	// 预警弧：剩余 ≤20%，inset -3px、遮罩内半径 9.5px（= 19/2）、zone-start 72deg
	assert.match(source, /showContextWarnArc\(leftPercent\)/);
	assert.match(source, /<span data-warn=\{warnArc \? "true" : "false"\} className="ctx-ring-warnarc" \/>/);
	assert.match(source, /"--zone-start": `\$\{CONTEXT_WARN_ZONE_START_DEG\}deg`/);
	assert.match(css, /\.ctx-ring-warnarc \{[\s\S]{0,400}?inset: -3px;/);
	assert.match(css, /mask: radial-gradient\(circle, transparent 0 9\.5px, #000 9\.5px\);/);
	assert.match(css, /\.ctx-ring-warnarc\[data-warn="true"\] \{[\s\S]{0,40}?opacity: 1;/);
});

test("meter ring colors encode state via ctx semantic tokens (no second palette)", () => {
	const source = meterSource();
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	// 分档来自纯函数（utils/contextSpend），组件只把它写进 data-level；
	// 双色变量与边框在 CSS 里按 [data-level] 取 --ctx-* 语义 token。
	assert.match(source, /contextRingLevel\(leftPercent\)/);
	assert.match(source, /data-level=\{contextLevelAttribute\(ringLevel\)\}/);
	// 五档都在 CSS 里有定义（一个类 + data-level，避免动态类名扫不到导致环变灰）
	for (const level of ["normal", "notice", "warn", "danger", "critical"]) {
		assert.ok(css.includes(`.ctx-ring-host[data-level="${level}"] {`), `CSS 缺少 ${level} 档`);
	}
	// 双色映射与 dev 文档 §2.1 一致
	assert.match(css, /\.ctx-ring-host\[data-level="normal"\] \{[\s\S]{0,120}?--ring-a: var\(--ctx-ok\);[\s\S]{0,80}?--ring-b: var\(--ctx-ok2\);/);
	assert.match(css, /\.ctx-ring-host\[data-level="notice"\] \{[\s\S]{0,120}?--ring-a: var\(--ctx-warn\);[\s\S]{0,80}?--ring-b: var\(--ctx-warn2\);/);
	assert.match(css, /\.ctx-ring-host\[data-level="critical"\] \{[\s\S]{0,120}?--ring-a: var\(--ctx-warn2\);[\s\S]{0,80}?--ring-b: var\(--ctx-danger\);/);
	// 数字色随档位（normal 用主文字色，预警/危险用状态色）
	assert.match(css, /\.ctx-ring-host\[data-level="notice"\] \.ctx-ring-pct,[\s\S]{0,80}?\.ctx-ring-host\[data-level="warn"\] \.ctx-ring-pct \{[\s\S]{0,60}?color: var\(--ctx-warn\);/);
	assert.match(css, /\.ctx-ring-host\[data-level="danger"\] \.ctx-ring-pct,[\s\S]{0,80}?\.ctx-ring-host\[data-level="critical"\] \.ctx-ring-pct \{[\s\S]{0,60}?color: var\(--ctx-danger\);/);
	// 旧的灰环描边（border/tertiary）不得回归
	assert.doesNotMatch(source, /stroke-\[var\(--color-border\)\]/);
	assert.doesNotMatch(source, /stroke-\[var\(--color-text-tertiary\)\]/);
});

test("meter mounts the serial spend animation from the shared hook", () => {
	const source = meterSource();
	// 扣血动画：数据/队列/去重都在 hook 里，组件只负责渲染与 animationend 推进
	assert.match(source, /import \{ useContextSpendEffects \} from "\.\.\/\.\.\/hooks\/useContextSpendEffects"/);
	assert.match(source, /useContextSpendEffects\(\{ sessionId: props\.sessionId, tokens: props\.state\?\.contextTokens \}\)/);
	assert.match(source, /data-testid="session-context-spend"/);
	assert.match(source, /animate-context-hit/);
	assert.match(source, /onAnimationEnd=\{spend\.onSpendAnimationEnd\}/);
	// 圆环同步 pulse（620ms）：让「扣血」有主体，而不是只有一条飞过的数字
	assert.match(source, /animate-context-pulse/);
	// key=pulseKey：同一标签连续两次也要重挂元素重启动画
	assert.match(source, /key=\{spend\.pulseKey\}/);
	// 扣血元素不可拦截指针（圆环按钮仍可点）
	assert.match(source, /pointer-events-none absolute top-1\/2 right-full/);
});

test("contextSegments prefers host breakdown and falls back to estimate split", () => {
	const { contextSegments } = loadMeterHelpers();
	const seg = (state) => {
		const result = contextSegments(state);
		if (result === null) return null;
		return result.kind === "breakdown" ? `breakdown:${result.system}:${result.tools}:${result.conversation}` : `estimate:${result.conversation}:${result.systemTools}`;
	};
	// host contextBreakdown 投影（dsh）：系统/工具/对话三段直接可用，0 也是有效值
	assert.equal(seg({ contextSystemTokens: 2400, contextToolsTokens: 1800, contextMessageTokens: 57600 }), "breakdown:2400:1800:57600");
	assert.equal(seg({ contextSystemTokens: 0, contextToolsTokens: 0, contextMessageTokens: 0 }), "breakdown:0:0:0");
	// 无投影（pi）：对话 = 消息估算 token，系统+工具 = 反推余量
	assert.equal(seg({ contextTokens: 128000, contextMessageTokens: 57600 }), "estimate:57600:70400");
	// 估算超过总量时对话封顶，系统+工具为 0（不出现负数）
	assert.equal(seg({ contextTokens: 1000, contextMessageTokens: 5000 }), "estimate:1000:0");
	// 缺任一字段 = 无估算（渲染单段条）
	assert.equal(seg(undefined), null);
	assert.equal(seg({ contextTokens: 128000 }), null);
	assert.equal(seg({ contextMessageTokens: 100 }), null);
	assert.equal(seg({ contextTokens: 0, contextMessageTokens: 100 }), null);
});

test("meter panel shows the localized reading and ~used/window figures", () => {
	const source = meterSource();
	// 面板 320px：style.width 与定位回退共用 PANEL_WIDTH，避免首帧 offsetWidth=0 时按旧 264 错位
	assert.match(source, /const PANEL_WIDTH = 320/);
	assert.match(source, /width: PANEL_WIDTH/);
	assert.match(source, /panel\.offsetWidth \|\| PANEL_WIDTH/);
	assert.doesNotMatch(source, /w-\[264px\]/);
	assert.match(source, /t\("sessionContext\.used", \{ percent: formatPercent\(percent\) \}\)/);
	assert.match(source, /formatTokens\(context\.usedTokens!\)\} \/ \$\{formatTokens\(context\.contextWindow!\)\}/);
	// 面板占用条：4px 圆角条，宽度按 percent
	assert.match(source, /h-1 overflow-hidden rounded-full bg-muted/);
	assert.match(source, /width: `\$\{percent\}%`/);
	assert.match(source, /data-testid="session-context-meter"/);
});

test("panel adds dsh-style segments legend when message estimate exists", () => {
	const source = meterSource();
	// 三段（host breakdown）与两段（估算）图例共用色：对话蓝、工具紫、系统蓝灰
	assert.match(source, /COLOR_CONVERSATION = "var\(--color-context-conversation, #2563eb\)"/);
	assert.match(source, /COLOR_SYSTEM_TOOLS = "var\(--color-context-system-tools, rgb\(167, 139, 250\)\)"/);
	assert.match(source, /COLOR_TOOLS = "var\(--color-context-tools, rgb\(167, 139, 250\)\)"/);
	assert.match(source, /COLOR_SYSTEM = "var\(--color-context-system, #94a3b8\)"/);
	// host breakdown 三段条：宽度 = percent × 份额 / breakdownTotal（dsh-web 同宽算法）
	assert.match(source, /breakdownSegments/);
	assert.match(source, /percent \* part\.tokens\) \/ breakdownTotal/);
	// 估算两段条：宽度按占 contextWindow 比例（与单段总占用条同一容器；
	// context 可能为 null（占位环）时 ?? 1 兜底，避免除零）
	assert.match(source, /segments\.conversation \/ \(context\?\.contextWindow \?\? 1\)/);
	assert.match(source, /segments\.systemTools \/ \(context\?\.contextWindow \?\? 1\)/);
	// 图例行：swatch + 文案 + 右侧 ~tokens（dsh rows 形态）
	assert.match(source, /t\("sessionContext\.conversation"\)/);
	assert.match(source, /t\("sessionContext\.systemTools"\)/);
	assert.match(source, /t\("sessionContext\.system"\)/);
	assert.match(source, /t\("sessionContext\.tools"\)/);
	assert.match(source, /size-2 flex-none rounded-\[2px\]/);
	assert.match(source, /~\{formatTokens\(segments\.conversation\)\}/);
	assert.match(source, /~\{formatTokens\(segments\.system\)\}/);
});

test("input/output token row drops arrows and keeps values on one line", () => {
	const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	const meter = meterSource();
	// 标签已是「输入/输出 tokens」，数值不再套 ↑/↓（箭头加长字符串，且 `/ ↓` 会在窄面板折行）
	assert.match(surface, /label: t\("ctx\.detail\.tokens"\),\s*value: `\$\{formatCompact\(state\.inputTokens\)\} \/ \$\{formatCompact\(state\.outputTokens\)\}`,/);
	assert.doesNotMatch(surface, /↑ \$\{formatCompact\(state\.inputTokens\)\} \/ ↓/);
	// 详情数值禁止折行：tooltip 与上下文面板共用同一 builder 文案，窄宽下必须 nowrap
	assert.match(surface, /min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-popover-foreground/);
	assert.match(meter, /min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground/);
});

test("panel reuses the SessionStatus detail builder and keeps compact action", () => {
	const source = meterSource();
	// 详情复用会话头部 SessionStatus 的构建器：两处明细语义一致（首字/耗时/tps 等）
	assert.match(source, /import \{ buildSessionStatusDetail \} from "\.\/SurfaceComponents"/);
	assert.match(source, /const detail = buildSessionStatusDetail\(\s*props\.state,/);
	assert.match(source, /props\.state\?\.cacheHitAveragePercent \?\? undefined,/);
	// 明细行与「最近一次回复」性能组分开渲染（不混读为会话均值）；
	// 输入/输出 token 与最新缓存命中率已常驻输入框下方（ComposerStatsLine），
	// 圆环面板消费前过滤这两行，避免重复展示
	assert.match(source, /panelDetailRows\.map\(/);
	assert.match(source, /row\.label !== t\("ctx\.detail\.tokens"\) && row\.label !== t\("ctx\.detail\.hitLatest"\)/);
	assert.match(source, /detail\.replyPerfRows\.map\(/);
	assert.match(source, /t\("ctx\.detail\.lastReply"\)/);
	// DSH 会话统计组（host sessionStats 投影；回合/墙钟/平均首字/生成速度）
	assert.match(source, /detail\.sessionStatRows\.map\(/);
	assert.match(source, /t\("ctx\.detail\.sessionStats"\)/);
	assert.match(source, /row\.emphasis \? " mt-1 border-t border-border\/70 pt-1\.5" : ""/);
	// 旧的自实现三行（命中率/输入输出/费用）已删除，避免与 builder 重复
	assert.doesNotMatch(source, /sessionContext\.cacheHit/);
	assert.doesNotMatch(source, /sessionContext\.inputOutput/);
	assert.doesNotMatch(source, /sessionContext\.cost/);
	// 压缩按钮：从右上角紧凑徽章迁入面板底部；可用态/紧急色走 compactUiState
	assert.match(source, /t\("sessionContext\.compact"\)/);
	assert.match(source, /t\("sessionContext\.compacting"\)/);
	assert.match(source, /t\("sessionContext\.compactNotReady"\)/);
	assert.match(source, /compactUi\.urgency === "danger" \? "text-destructive/);
	assert.match(source, /compactUi\.urgency === "warn" \? "text-amber-500/);
	assert.match(source, /disabled=\{compactDisabled\}/);
	assert.match(source, /onClick=\{props\.onCompact\}/);
	assert.match(source, /showCompact = props\.onCompact !== undefined/);
	assert.match(source, /data-testid="session-context-compact"/);
});

test("panel re-anchors on scroll instead of closing during streaming", () => {
	const source = meterSource();
	// 定位逻辑抽成 positionPanel 供 layout effect 与滚动/resize 复用
	assert.match(source, /const positionPanel = useCallback\(\(\) => \{\s*const trigger = triggerRef\.current;/);
	// 滚动监听回调不再是「关闭面板」（旧行为：任何滚动/缩放都 setOpen(false)，
	// 流式渲染追底滚动会反复点开即关）
	assert.doesNotMatch(source, /const onViewportChange = \(\): void => setOpen\(false\);/);
	assert.doesNotMatch(source, /addEventListener\("scroll", onViewportChange, true\)/);
	// 改为重新锚定：capture 滚动 + rAF 合并 + 位置未变不重复 setState
	// （流式追底滚动每帧触发 scroll，trigger 固定时避免每帧 re-render）
	assert.match(source, /addEventListener\("scroll", reanchor, true\)/);
	assert.match(source, /requestAnimationFrame\(positionPanel\)/);
	// 格式化后单行且无尾逗号：只锁「位置未变则复用 prev」的比较语义。
	assert.match(source, /setPlacement\(\(prev\) => \(prev !== null && prev\.left === left && prev\.top === top \? prev : \{ left, top \}\)\);/);
	// 外点 / Escape 仍是唯一关闭途径（监听保持）
	assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
	assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("bottom bar wires the meter next to send controls and merges model + thinking into one chip", () => {
	const source = bottomBarSource();
	// ContextMeter 挂在右侧组（git 分支之前、发送控件同组）
	assert.match(source, /import \{ SessionContextMeter \} from "\.\/SessionContextMeter"/);
	assert.match(source, /<SessionContextMeter\s*sessionId=\{props\.sessionId\}\s*state=\{props\.state\}\s*onCompact=\{props\.onCompact\}\s*backend=\{usageBackend\}[\s\S]{0,200}?fallbackProvider=\{modelProvider\}/);
	assert.match(source, /composer-bottom-right ml-auto flex shrink-0 items-center gap-2/);
	// 模型/思考合并 chip：模型名 · 思考档位 + chevron（dsh ModelSelect trigger 形态，保持原样）
	assert.match(source, /composer-bar-btn model-thinking/);
	// 分隔点 span 内的 · 被格式化到独立一行，断言只要求「模型值后紧跟该分隔点 span」。
	assert.match(source, /\{modelValue\}<\/span>[\s\S]{0,80}?<span className="flex-none text-muted-foreground\/70" aria-hidden="true">[\s\S]{0,10}?·[\s\S]{0,10}?<\/span>/);
	assert.match(source, /<ChevronDown\s*size=\{12\}/);
	assert.match(source, /rotate-180/);
	// 旧的「两行 drill-in 菜单」（模型 / 思考 + ChevronRight）已整体移除：
	// 点 chip 现在直接弹一级浮层（pill + 滑块），点 pill 进二级模型列表。
	assert.doesNotMatch(source, /drillIn\(props\.onPickModel\)/);
	assert.doesNotMatch(source, /drillIn\(props\.onPickThinking\)/);
	assert.match(source, /<ModelEffortPopover/);
	assert.match(source, /<ModelPickerBody/);
	// 旧的分离按钮（绿色思考、斜体模型）不再存在
	assert.doesNotMatch(source, /composer-bar-btn model flex h-7/);
	assert.doesNotMatch(source, /composer-bar-btn thinking h-7 max-w-\[10rem\]/);
});

test("composer chip popover: two levels share one container, effort colors the pill text only", () => {
	const components = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const popover = readFileSync("src/renderer/src/components/session/ModelEffortPopover.tsx", "utf8");
	const slider = readFileSync("src/renderer/src/components/session/EffortSlider.tsx", "utf8");
	// 两级共用一个容器：data-view 切换 + width/left 同步过渡 220ms（原型定稿值）
	assert.match(popover, /data-view=\{props\.view\}/);
	assert.match(popover, /transition-\[width,left\] duration-\[220ms\] ease-out-quint/);
	assert.match(popover, /const MODELS_WIDTH = 452/);
	assert.match(popover, /const EFFORT_MIN_WIDTH = 230/);
	assert.match(popover, /const EFFORT_MAX_WIDTH = 430/);
	// 状态机事件而不是散落的 setState：转移表在 utils/modelEffortPopover 单测
	assert.match(popover, /onViewEvent\(\{ kind: "toModels" \}\)/);
	assert.match(popover, /onViewEvent\(\{ kind: "pickModel" \}\)/);
	assert.match(popover, /onViewEvent\(\{ kind: "escape" \}\)/);
	assert.match(popover, /onViewEvent\(\{ kind: "outside" \}\)/);
	// ★ 档位名固定宽度 46px：否则拖动改档位 → pill 变宽 → 浮层重量宽度 → 轨道漂移
	assert.match(popover, /min-w-\[46px\]/);
	// ★ 宽度只在模型变化时重算：effect 依赖里是 modelKey 而不是 currentEffort
	assert.match(popover, /\[open, props\.view, modelKey, place\]/);
	// 定位：按 chip 居中并在视口边界内钳制；上方空间不足时翻转
	// （portal + fixed 后 left 直接相对 viewport，见下方 portal 回归测试）
	assert.match(popover, /const left = Math\.round\(Math\.max\(EDGE_GAP, Math\.min\(maxLeft, centered\)\)\)/);
	assert.match(popover, /spaceAbove >= height \? \{ left, bottom:/);
	// 滑块固定蓝色：档位色只作用于 pill 文字（effortColorVar）
	assert.match(slider, /var\(--color-info\)/);
	assert.doesNotMatch(slider, /effortColorVar/);
	assert.match(components, /effortColorVar\(props\.currentEffort\)/);
	// ★ setPointerCapture 要 try/catch（无活动指针时抛 NotFoundError 会打断 apply）
	assert.match(slider, /try \{[\s\S]{0,120}?setPointerCapture\(event\.pointerId\)/);
	assert.match(slider, /\} catch \{/);
	// 键盘：←/→/Home/End 走纯函数映射
	assert.match(slider, /effortIndexForKey\(event\.key, index, count\)/);
});

test("context meter copy is present in both locale dictionaries", () => {
	assert.match(zh(), /"sessionContext\.used": "上下文已用 \{percent\}%"/);
	assert.match(en(), /"sessionContext\.used": "\{percent\}% of context used"/);
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"sessionContext\.figures": "~\{used\} \/ \{window\}"/);
		assert.match(locale, /"sessionContext\.conversation":/);
		assert.match(locale, /"sessionContext\.systemTools":/);
		// host breakdown 三段图例文案（系统/工具/对话）
		assert.match(locale, /"sessionContext\.system":/);
		assert.match(locale, /"sessionContext\.tools":/);
		// 会话统计组文案（DSH sessionStats 投影）
		assert.match(locale, /"ctx\.detail\.sessionStats":/);
		assert.match(locale, /"ctx\.detail\.turnsSteps":/);
		assert.match(locale, /"ctx\.detail\.llmDuration":/);
		assert.match(locale, /"ctx\.detail\.toolDuration":/);
		assert.match(locale, /"ctx\.detail\.ttftAverage":/);
		// 命中/输入输出/费用行已并入共享明细构建器（ctx.detail.*），面板不再单独占用文案 key
		assert.doesNotMatch(locale, /"sessionContext\.cacheHit":/);
		assert.doesNotMatch(locale, /"sessionContext\.cacheHitAvg":/);
		assert.doesNotMatch(locale, /"sessionContext\.inputOutput":/);
		assert.doesNotMatch(locale, /"sessionContext\.cost":/);
		assert.match(locale, /"sessionContext\.compact":/);
		assert.match(locale, /"sessionContext\.compacting":/);
		assert.match(locale, /"sessionContext\.compactNotReady":/);
		assert.match(locale, /"sessionContext\.compactNotReadyHint":/);
	}
});

test("usage block is delegated to the shared ProviderUsageDetails with settings deep-link on failure", () => {
	const source = meterSource();
	// 圆球面板用量区块 = 共享 ProviderUsageDetails（与模型选择器展开区同一份数据源与视觉，
	// 本组件只决定「是否渲染」与「失败跳转」，不再自持 fetch/缓存/展示逻辑）
	assert.match(source, /import \{ ProviderUsageDetails \} from "\.\.\/app\/ProviderUsageDetails"/);
	assert.match(source, /<ProviderUsageDetails provider=\{provider\} backend=\{props\.backend\} onConfigureUsage=\{onConfigureUsage\} \/>/);
	// 失败态入口 = 跳「设置 → 配置管理 → 模型」并定位该供应商（openSettingsAtom 深链）
	assert.match(source, /openSettingsAtom/);
	assert.match(source, /configTab: "models", provider \}/);
	// 旧的「装 skill + 预填输入框」链路已整体删除（配置唯一入口在模型页）
	assert.doesNotMatch(source, /onInsertUsageProbePrompt/);
	assert.doesNotMatch(source, /installUsageSkill/);
	assert.doesNotMatch(source, /usageCache/);
});

test("picker shows usage inline on the provider group row; provider config pages keep the header badge", () => {
	// 用量单值位随列表主体抽到 ModelPickerBody（Dialog 与底栏二级浮层共用一份）。
	const picker = readFileSync("src/renderer/src/components/session/ModelPickerBody.tsx", "utf8");
	// 用量回到「模型提供商」标题行右侧（trailing inline 单值位）：无数据/未启用时不渲染，
	// 所以标题行保持干净；backend 随会话后端透传（DSH 会话走 dsh 链路，不误查 pi 的 usage-probes.json）。
	assert.match(picker, /trailing=\{<ProviderUsageInline provider=\{provider\} variant="row" backend=\{props\.backend\} \/>\}/);
	assert.match(picker, /useProviderUsageBatchRefresh/);
	// 展开区不再挂用量明细块（明细在圆球面板；标题行只放单值位）。
	assert.doesNotMatch(picker, /ProviderUsageDetails/);
	assert.doesNotMatch(picker, /className="border-t-0 pt-1"/);
	// command-picker 仍保留 trailing 插槽（其他 picker 可能用）。
	const commandPicker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
	assert.match(commandPicker, /trailing\?: ReactNode/);
	// Pi 模型页：折叠卡片不再另开 h-9 底栏——模型数徽章 + 卡头用量徽标都收进标题行；
	// 展开体里的「用量」明细块（ProviderUsageDetails）仍不挂（卡头徽标已覆盖展示）；
	// 整行点击展开来自上游，卡头徽标常驻；模型/认证/DSH 三页统一。
	const modelsTab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	assert.match(modelsTab, /ProviderUsageInline\s+provider=\{name\}\s+variant="card"/);
	assert.match(modelsTab, /UsageQueryEntryButton/);
	assert.match(modelsTab, /config\.count\.models/);
	assert.match(modelsTab, /cursor-pointer/);
	assert.match(modelsTab, /onClick=\{\(\) => props\.onToggleProvider\(name\)\}/);
	assert.doesNotMatch(modelsTab, /ProviderUsageDetails/);
	assert.doesNotMatch(modelsTab, /ProviderUsageRow/);
	assert.doesNotMatch(modelsTab, /leading=/);
	assert.match(modelsTab, /UsageQueryEntryButton/);
	const inlineSource = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
	assert.match(inlineSource, /variant: "row" \| "card"/);
	assert.doesNotMatch(inlineSource, /export function ProviderUsageFooter/);
	assert.doesNotMatch(inlineSource, /export function ProviderUsageRow/);
	assert.doesNotMatch(inlineSource, /provider-usage-configure-icon/);
	const entryButton = readFileSync("src/renderer/src/components/app/UsageQueryEntryButton.tsx", "utf8");
	// 「用量查询」按钮常驻：不再因内置识别命中而隐藏（认证页/模型卡片都要能看到这个图标与开关入口）。
	assert.doesNotMatch(entryButton, /useProviderUsageRecognized/);
	assert.match(entryButton, /provider-usage-configure-icon/);
	assert.match(entryButton, /BarChart3/);
	const authTab = readFileSync("src/renderer/src/config/AuthTab.tsx", "utf8");
	// 认证页卡片同样常驻徽章（只读展示，开关在右侧「用量查询」弹窗里），仍不挂详情块（详情在圆球/选择器展开区）。
	assert.match(authTab, /<ProviderUsageInline provider=\{name\} variant="card" \/>/);
	assert.doesNotMatch(authTab, /ProviderUsageDetails/);
	assert.doesNotMatch(authTab, /ProviderUsageRow/);
	assert.match(authTab, /UsageQueryEntryButton/);
	const dshCards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
	// DSH 卡片徽章必须走 dsh 链路（配置/凭据都在 $DSH_HOME，不误读 pi 的 usage-probes.json）。
	assert.match(dshCards, /<ProviderUsageInline provider=\{entry\.key\} variant="card" backend="dsh" \/>/);
	assert.match(dshCards, /<ProviderUsageInline provider="deepseek" variant="card" backend="dsh" \/>/);
	assert.doesNotMatch(dshCards, /ProviderUsageDetails/);
	assert.match(dshCards, /config\.dsh\.modelsCount/);
	assert.doesNotMatch(dshCards, /ProviderUsageRow/);
	assert.match(dshCards, /UsageQueryEntryButton/);
	// 旧胶囊徽标组件已删除（cc-switch 风格无胶囊）
	assert.equal(existsSync("src/renderer/src/components/app/ProviderUsageBadge.tsx"), false);
});

test("provider usage inline stays silent when usage is not enabled", () => {
	const source = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
	// 未开启/失败/不支持 → 不渲染任何文案（查不到就不显示），底部行组件已删除、无空占位。
	assert.doesNotMatch(source, /provider-usage-not-enabled/);
	assert.doesNotMatch(source, /provider-usage-footer-configure/);
	assert.doesNotMatch(source, /空占位/);
});

test("recognized usage badge keeps its label separated from the hint", () => {
	const source = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");
	const badgeSection = source.match(/\{hintKey && \([\s\S]*?\n\s*\)\}/)?.[0] ?? "";
	// 徽标文字按单行盒渲染，并与下一行说明保持明确间距，避免高字号/主题切换时叠字。
	assert.match(badgeSection, /text-micro leading-none tracking-wide/);
	// 徽标与说明同行布局：水平 flex + 明确间距，既防叠字又防 flex-col cross-axis stretch
	// 把徽标拉成整行宽的「大灰杠」（用户截图里的视觉 bug）。
	assert.match(badgeSection, /flex items-center gap-2/);
	// 徽标必须显式禁止在 flex 轴上收缩/拉伸，保持内容宽。
	assert.match(badgeSection, /inline-flex shrink-0/);
	assert.doesNotMatch(badgeSection, /flex flex-col/);
});

test("provider usage inline keeps no bottom row footprint", () => {
	const source = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
	// 底部行组件（ProviderUsageRow）已随三处页面迁移删除：无 justify-end/h-9 底栏残留。
	assert.doesNotMatch(source, /export function ProviderUsageRow/);
	assert.doesNotMatch(source, /justify-end/);
	assert.doesNotMatch(source, /h-9/);
});

test("usage probe dialog separates title from enable row", () => {
	const source = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");
	// 标题与启用开关是两个视觉层级，标题下必须保留稳定的呼吸间距。
	assert.match(source, /<DialogHeader className="px-5 pt-4 pb-2">/);
});

test("usage probe dialog lives outside all TabsContent (tab switch must not unmount it)", () => {
	// 回归契约：弹窗曾放在 config:models TabsContent 内，Radix Tabs 默认卸载非激活内容，
	// 导致切到认证 tab / DSH 页时弹窗被卸载、点击柱状图按钮「没反应」。
	const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(configModal, /<\/TabsContent>\s*<\/Tabs>\s*\{\/\* 用量查询配置弹窗[\s\S]*?<UsageProbeConfigDialog/, "用量查询弹窗必须挂在最外层 Tabs（Pi/DSH 分页）之外");
});

test("ProviderUsageDetails renders each usage window as a labeled progress row", () => {
	const source = readFileSync("src/renderer/src/components/app/ProviderUsageDetails.tsx", "utf8");
	// 多窗口分支优先命中（windows.length > 0 在普通 credits 分支之前）
	assert.match(source, /windows\.length > 0 \? \(/);
	// 每个窗口一行：label（5h/周）+ 进度条 + 百分比 + 剩余小字
	// 窗口 label 走 providerUsageDisplay.usageWindowLabelText 统一映射
	// （与 inline 多段行同源；内置 key 统一 i18n，未知 key 原样展示）
	assert.match(source, /usageWindowLabelText\(window\.key, t\)/);
	assert.match(source, /t\("sessionContext\.usageWindowRemaining", \{ n: formatAmount\(remaining\) \}\)/);
	// 用超封顶 100、≥90% 红字警示（与 periods 同判断）
	assert.match(source, /Math\.min\(100, Math\.round\(\(used \/ total\) \* 100\)\)/);
	assert.match(source, /pct != null && pct >= 90/);
});

test("usage windows copy is present in both locale dictionaries", () => {
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"sessionContext\.usageWindowFiveHour":/);
		assert.match(locale, /"sessionContext\.usageWindowWeekly":/);
		assert.match(locale, /"sessionContext\.usageWindowRemaining":/);
	}
	assert.match(zh(), /"sessionContext\.usageWindowFiveHour": "5小时"/);
	assert.match(en(), /"sessionContext\.usageWindowFiveHour": "5h"/);
});

// 圆环常驻：无 capacity 数据（会话未运行/模型切换瞬间）也渲染 0% 占位环，
// 面板内容降级为「暂不可用」，不再整环隐藏（用户要求非激活会话也要常驻）。
test("meter stays visible without capacity: placeholder ring + unavailable panel", () => {
	const source = meterSource();
	// percent 兜底 0：环照画（strokeDasharray 按 percent 计算），不 return null
	assert.match(source, /const percent = context\?\.percent \?\? 0;/);
	assert.doesNotMatch(source, /if \(context === null\) return null/);
	// 面板标题走 reading（占位时显示 unavailable 文案），figures 仅在可用时渲染
	assert.match(source, /<span className="text-text-tertiary">\{reading\}<\/span>/);
	assert.match(source, /\{available && figures !== undefined && /);
	// 不再因 capacity 消失自动关闭面板
	assert.doesNotMatch(source, /if \(!available && open\) setOpen\(false\)/);
	// 面板定位/外点/滚动监听不再受可用性限制
	assert.doesNotMatch(source, /if \(!open \|\| !available\) return;/);
	// 占用条/图例在无可用时隐藏；压缩按钮无数据时传 undefined → compactUiState not ready（禁用）
	assert.match(source, /\{available && segments !== null && \(/);
	assert.match(source, /t\("sessionContext\.unavailable"\)/);
});

test("placeholder copy is present in both locale dictionaries", () => {
	assert.match(zh(), /"sessionContext\.unavailable": "上下文数据暂不可用"/);
	assert.match(en(), /"sessionContext\.unavailable": "Context data unavailable"/);
});

test("usage provider falls back to session/default model so idle sessions can still probe usage", () => {
	const meterSource = readFileSync(meterPath, "utf8");
	// 非激活会话没有 runtime state，组件用会话记录/默认 model 推导的 provider 兜底查用量
	assert.match(meterSource, /fallbackProvider\?: string/);
	assert.match(meterSource, /const provider = props\.state\?\.provider\?\.trim\(\) \|\| props\.fallbackProvider\?\.trim\(\) \|\| undefined;/);
	// 用量查询不依赖 agent 运行（注释里明示设计意图）
	assert.match(meterSource, /用量查询不依赖 agent 运行/);
});

test("effort popover resolves the displayed level when the current one is unsupported (§1.8)", () => {
	const popover = readFileSync("src/renderer/src/components/session/ModelEffortPopover.tsx", "utf8");
	// 当前档位不在新模型集合内时，滑块不能用 indexOf=-1 把圆钮钉在首档而 pill 仍显示旧档位：
	// 展示层先做兜底（resolveEffortAfterModelChange + defaultEffortFallback）。
	assert.match(popover, /const displayEffort = levelValues\.length === 0 \? \(props\.currentEffort \?\? ""\) : resolveEffortAfterModelChange\(/);
	assert.match(popover, /fallback: defaultEffortFallback\(levelValues\)/);
	// EffortView 消费的是兜底后的值（不是 props.currentEffort 原值）
	assert.match(popover, /effort=\{displayEffort\}/);
	assert.match(popover, /effortText=\{displayEffortText\}/);
	// 刻意不发第二条 setRuntimeThinking：后端换模型时已按目标模型 defaultEffort 重选档位，
	// 前端再发会与它竞争（DSH selectModelWithCatalogEffort 明确不沿用旧档位）。
	// 断言写成「不得出现调用」的形式，避免命中上面注释里的说明文字。
	assert.doesNotMatch(popover, /await\s+applyThinking|desktopApi\.sessions\.setRuntimeThinking/);
});

/**
 * 2026-09 回归：浮层被底栏祖先的 overflow-hidden 裁掉。
 *
 * 症状极具误导性：点 chip **完全没反应**——DOM 里节点存在、visibility: visible、
 * 定位数值正确，但屏幕上看不见（ComposerArea 的 footer 与 composer-bottom-center
 * 都是 overflow-hidden，absolute 浮层会被裁掉）。
 * 旧实现用 Radix PopoverContent（自带 portal）所以没这个问题；自绘容器必须自己 portal。
 * 已实测：改为 createPortal + fixed 后浮层出现在 chip 正上方 9px。
 */
test("chip 浮层必须 portal 到 body（底栏 overflow-hidden 会裁掉 absolute 浮层）", () => {
	const popover = readFileSync("src/renderer/src/components/session/ModelEffortPopover.tsx", "utf8");
	// 必须 portal 到 body
	assert.match(popover, /import \{ createPortal \} from "react-dom"/);
	assert.match(popover, /return createPortal\(/);
	assert.match(popover, /document\.body,\s*\);/);
	// 必须是 fixed（相对 viewport）而不是 absolute（相对 chip 宿主）
	assert.match(popover, /className="fixed z-\(--z-popover\)/);
	assert.doesNotMatch(popover, /className="absolute z-/);
	// 祖先链上的 overflow-hidden 是根因，断言它确实存在（若哪天被移除，本测试的前提需重评）
	const components = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	assert.match(components, /composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4\$\{isImageGenMode \? " overflow-x-auto overflow-y-hidden \[scrollbar-width:none\]" : " overflow-hidden"\}/);
	assert.match(area, /<footer ref=\{footerRef\} className="composer flex max-h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden/);
});

test("chip 浮层定位相对 viewport（portal 后不能再相对 chip 宿主算 left）", () => {
	const popover = readFileSync("src/renderer/src/components/session/ModelEffortPopover.tsx", "utf8");
	// left 直接由 anchor 相对 viewport 的中心算出，不再减去宿主 left
	assert.match(popover, /const centered = anchorRect\.left \+ anchorRect\.width \/ 2 - nextWidth \/ 2/);
	// 垂直：优先贴 chip 上方（bottom），放不下才翻转（top）
	assert.match(popover, /const spaceAbove = anchorRect\.top - ANCHOR_GAP - EDGE_GAP/);
	assert.match(popover, /spaceAbove >= height \? \{ left, bottom: Math\.round\(window\.innerHeight - anchorRect\.top \+ ANCHOR_GAP\) \} : \{ left, top: Math\.round\(anchorRect\.bottom \+ ANCHOR_GAP\) \}/);
	// 首帧未定位时隐藏，避免闪一下错位
	assert.match(popover, /visibility: placement === null \? "hidden" : "visible"/);
	// 滚动/resize 后重新锚定（fixed 不随滚动移动）
	assert.match(popover, /addEventListener\("scroll", reanchor, true\)/);
	assert.match(popover, /addEventListener\("resize", reanchor\)/);
});
