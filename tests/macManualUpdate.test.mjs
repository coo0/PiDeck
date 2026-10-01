import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

let defaultFetchResponse;
let defaultFetchRequest;

const { MAC_MANUAL_LATEST_RELEASE_URL, createMacManualUpdateChecker, parseGitHubReleaseVersion, parseLatestReleaseTagFromJson, resolveLatestReleaseVersion, shouldReadJsonBody } = loadTsCommonJs("src/main/update/macManualUpdate.ts", {
	stubs: {
		electron: {
			net: {
				fetch: async (...args) => {
					defaultFetchRequest = args;
					if (!defaultFetchResponse) throw new Error("not used in test");
					return defaultFetchResponse;
				},
			},
		},
	},
});

test("parseGitHubReleaseVersion accepts a redirected latest-release tag only", () => {
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4"), "0.7.4");
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/0.7.4-beta.1"), "0.7.4-beta.1");
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("https://atomgit.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("not a URL"), null);
});

test("parseLatestReleaseTagFromJson reads AtomGit / GitHub REST tag_name", () => {
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "v0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson("{"), null);
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ name: "v0.7.6" })), null);
});

test("resolveLatestReleaseVersion prefers JSON tag_name and falls back to a legacy GitHub tag URL", () => {
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
			body: JSON.stringify({ tag_name: "v0.7.6" }),
		}),
		"0.7.6",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://api.github.com/repos/coo0/PiDeck/releases/latest",
			body: JSON.stringify({ tag_name: "v0.7.6" }),
		}),
		"0.7.6",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
		}),
		"0.7.4",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://api.github.com/repos/coo0/PiDeck/releases/latest",
			body: JSON.stringify({ tag_name: "   " }),
		}),
		null,
	);
});

test("shouldReadJsonBody is true for OpenAPI hosts and JSON content types", () => {
	assert.equal(shouldReadJsonBody("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest", "text/plain"), true);
	assert.equal(shouldReadJsonBody("https://api.github.com/repos/ayuayue/PiDeck/releases/latest", ""), true);
	assert.equal(shouldReadJsonBody("https://github.com/ayuayue/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://atomgit.com/ayuayue/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://example.com/latest", "application/json; charset=utf-8"), true);
});

test("manual macOS checker default fetcher reads the latest release JSON", async () => {
	defaultFetchResponse = {
		ok: true,
		status: 200,
		url: MAC_MANUAL_LATEST_RELEASE_URL,
		headers: { get: () => "application/json" },
		text: async () => JSON.stringify({ tag_name: "v0.7.4" }),
	};

	const check = createMacManualUpdateChecker();
	const result = await check("0.7.3");
	assert.equal(defaultFetchRequest[0], MAC_MANUAL_LATEST_RELEASE_URL);
	assert.equal(defaultFetchRequest[1].redirect, "follow");
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, true);
});

test("manual macOS checker requests the GitHub Releases API and detects beta -> stable", async () => {
	let requestedUrl = "";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url,
				body: JSON.stringify({ tag_name: "v0.7.4" }),
			};
		},
	});

	const result = await check("0.7.3-beta");
	assert.equal(requestedUrl, MAC_MANUAL_LATEST_RELEASE_URL);
	assert.match(requestedUrl, /^https:\/\/api\.github\.com\/repos\/coo0\/PiDeck\/releases\/latest$/);
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, true);
});

test("manual macOS checker does not flag the same stable version", async () => {
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: MAC_MANUAL_LATEST_RELEASE_URL,
			body: JSON.stringify({ tag_name: "v0.7.4" }),
		}),
	});

	const result = await check("0.7.4");
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker reads AtomGit OpenAPI tag_name when the HTML page has no tag URL", async () => {
	let requestedUrl = "";
	const apiUrl = "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url: apiUrl,
				body: JSON.stringify({ tag_name: "v0.7.6", release_status: "latest" }),
			};
		},
	});

	const result = await check("0.7.6", apiUrl);
	assert.equal(requestedUrl, apiUrl);
	assert.equal(result.latestVersion, "0.7.6");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker rejects missing tag_name and non-2xx responses", async () => {
	const unavailable = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({ ok: false, status: 503, url: MAC_MANUAL_LATEST_RELEASE_URL }),
	});
	await assert.rejects(() => unavailable("0.7.3"), /503/);

	const malformed = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: MAC_MANUAL_LATEST_RELEASE_URL,
			body: JSON.stringify({ name: "v0.7.4" }),
		}),
	});
	await assert.rejects(() => malformed("0.7.3"), /did not resolve/);

	const empty = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({ ok: true, status: 200, url: MAC_MANUAL_LATEST_RELEASE_URL, body: "" }),
	});
	await assert.rejects(() => empty("0.7.3"), /did not resolve/);
});
