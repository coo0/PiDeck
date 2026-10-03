import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const sessionPath = "src/renderer/src/components/session/";
const jsx = (type, props) => ({ type, props });
const react = {
	memo: (fn) => fn,
	useState: (value) => [value, () => {}],
	useRef: (value) => ({ current: value }),
	useCallback: (fn) => fn,
	useEffect: () => {},
	useLayoutEffect: () => {},
};
const sharedStubs = {
	react,
	"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
	"../../i18n": { t: (key) => key },
};

// Inspect rendered JSX without replacing the production event handlers.
function findNode(node, predicate) {
	if (!node || typeof node !== "object") return undefined;
	if (predicate(node)) return node;
	const children = node.props?.children ?? (Array.isArray(node) ? node : []);
	for (const child of [children].flat()) {
		const found = findNode(child, predicate);
		if (found) return found;
	}
	return undefined;
}

test("bottom bar forwards both recovery props and preserves ordinary compact", () => {
	const source = readFileSync(`${sessionPath}ComposerComponents.tsx`, "utf8");
	const meter = source.match(/<SessionContextMeter\b[\s\S]*?\/>/)?.[0];
	assert.ok(meter);
	for (const name of ["overflowRecoveryTarget", "onOverflowRecovery", "onCompact"]) {
		assert.match(meter, new RegExp(`\\b${name}\\s*=\\s*\\{\\s*props\\.${name}\\s*\\}`));
	}
});

test("overflow uses the full runtime target while ordinary compact retains readiness gates", () => {
	const { SessionContextMeter } = loadTsCommonJs(`${sessionPath}SessionContextMeter.tsx`, {
		stubs: {
			...sharedStubs,
			react: { ...react, useState: (value) => [value === false ? true : value, () => {}] },
			"react-dom": { createPortal: (node) => node },
			"lucide-react": { FoldVertical: "FoldVertical" },
			jotai: { useAtomValue: () => false, useSetAtom: () => () => {} },
			"../../atoms/app-ui-atoms": {},
			"../ui-shadcn/tooltip": {},
			"../app/ProviderUsageDetails": {},
			"./SurfaceComponents": { buildSessionStatusDetail: () => ({ detailRows: [], replyPerfRows: [], sessionStatRows: [] }) },
			"./TimelineFormat": { formatPercent: String },
			"../../hooks/useContextSpendEffects": { useContextSpendEffects: () => ({ spendLabel: null }) },
		},
		globals: { document: { body: {} } },
	});
	const target = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 7 };
	const recovered = [];
	let compactCalls = 0;
	const button = (state) => {
		const tree = SessionContextMeter({ sessionId: target.sessionId, state, overflowRecoveryTarget: target, onOverflowRecovery: (value) => recovered.push(value), onCompact: () => compactCalls++ });
		const result = findNode(tree, (node) => node.props?.["data-testid"] === "session-context-compact");
		assert.ok(result);
		return result.props;
	};
	const overflow = button({ contextOverflow: true });
	assert.equal(overflow.disabled, false);
	overflow.onClick();
	assert.equal(recovered[0], target);
	assert.equal(compactCalls, 0);
	assert.equal(button({}).disabled, true);
	assert.equal(button({ contextPercent: 50, contextWindow: 1000, isCompacting: true }).disabled, true);
	assert.equal(button({ contextOverflow: true, isCompacting: true }).disabled, true);
	const normal = button({ contextPercent: 50, contextWindow: 1000 });
	assert.equal(normal.disabled, false);
	normal.onClick();
	assert.equal(compactCalls, 1);
	assert.equal(recovered.length, 1);
});

test("stats receives session backend and queries DSH rather than the pi default", () => {
	const area = readFileSync(`${sessionPath}ComposerArea.tsx`, "utf8");
	const stats = area.match(/<ComposerStatsLine\b[\s\S]*?\/>/)?.[0];
	assert.ok(stats);
	const mapping = stats.match(/\bbackend\s*=\s*\{\s*composer\.backend\s*===\s*"([^"]+)"\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\}/);
	assert.ok(mapping);
	for (const [backend, expected] of [
		["dsh", "dsh"],
		["pi", "pi"],
		["imagegen", "pi"],
	]) {
		assert.equal(backend === mapping[1] ? mapping[2] : mapping[3], expected);
	}
	const { ComposerStatsLine } = loadTsCommonJs(`${sessionPath}ComposerStatsLine.tsx`, {
		stubs: { ...sharedStubs, "./TimelineFormat": {}, "./SessionContextMeter": {}, "../app/ProviderUsageInline": { ProviderUsageInline: "ProviderUsageInline" } },
	});
	for (const [backend, expected] of [
		["dsh", "dsh"],
		[undefined, "pi"],
	]) {
		const tree = ComposerStatsLine({ provider: "test-provider", backend });
		const usage = findNode(tree, (node) => node.type === "ProviderUsageInline");
		assert.ok(usage);
		assert.equal(usage.props.backend, expected);
	}
});

for (const [locale, exportName, expected] of [
	["zh-CN", "zhCN", "消耗 1.2k tokens"],
	["en-US", "enUS", "Spent 1.2k tokens"],
]) {
	test(`${locale} token copy interpolates tokens without duplicates or self-reference`, () => {
		const path = `src/renderer/src/i18n/rendererCopy.${locale}.ts`;
		const source = readFileSync(path, "utf8");
		assert.equal([...source.matchAll(/"composerEffort\.spendTokens"\s*:/g)].length, 1);
		const copy = loadTsCommonJs(path, { stubs: { "../../../shared/i18n/mainProcessCopy": { mainProcessZhCN: {}, mainProcessEnUS: {} } } })[exportName];
		const template = copy["composerEffort.spendTokens"];
		assert.notEqual(template, "composerEffort.spendTokens");
		assert.deepEqual(template.match(/\{\w+\}/g), ["{tokens}"]);
		assert.equal(template.replace("{tokens}", "1.2k"), expected);
		const hook = readFileSync("src/renderer/src/hooks/useContextSpendEffects.ts", "utf8");
		assert.match(hook, /t\(\s*"composerEffort\.spendTokens"\s*,\s*\{\s*tokens\s*:\s*formatSpendCount\(delta\)/);
	});
}
