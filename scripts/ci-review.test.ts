// Tests for the CI code-review script's token budgeting and error classification.
//
// Focus: a diff that overflows the model context window must be TRIMMED before
// sending, and — if it still cannot fit — reported as "diff too large", never as
// "API unavailable" (which is reserved for genuine reachability failures).

import { afterEach, beforeAll, describe, expect, it } from "bun:test";

// Suppress main() (which does network + gh calls + process.exit) on import.
process.env.__CI_REVIEW_TEST = "1";

let mod: typeof import("./ci-review");
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
	mod = await import("./ci-review");
	realFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const makeSection = (i: number, chars: number) => ({
	path: `file${i}.md`, // .md so full-file context is skipped (no git subprocess)
	diff: "d".repeat(chars),
});

describe("estimateTokens", () => {
	it("estimates tokens from characters conservatively", () => {
		expect(mod.estimateTokens("")).toBe(0);
		expect(mod.estimateTokens("x".repeat(35))).toBe(10); // 35 / 3.5
		// Over-estimates rather than under-estimates so we err toward trimming.
		expect(mod.estimateTokens("x".repeat(36))).toBe(Math.ceil(36 / 3.5));
	});
});

describe("classifyHttpError", () => {
	const ctxBody = JSON.stringify({
		message:
			"Please reduce the length of the messages or completion. Current length is 136333 while limit is 131072",
		type: "invalid_request_error",
		param: "messages",
		code: "context_length_exceeded",
	});

	it("classifies a 400 context_length_exceeded as too_large with parsed token counts", () => {
		const cls = mod.classifyHttpError(400, ctxBody);
		expect(cls.kind).toBe("too_large");
		expect(cls.tokenInfo).toEqual({ current: 136333, limit: 131072 });
	});

	it("classifies a generic 400 as a client_error, not unavailable", () => {
		expect(mod.classifyHttpError(400, '{"message":"bad param"}').kind).toBe(
			"client_error",
		);
	});

	it("classifies auth/rate-limit/server errors as unavailable", () => {
		expect(mod.classifyHttpError(401, "unauthorized").kind).toBe("unavailable");
		expect(mod.classifyHttpError(403, "forbidden").kind).toBe("unavailable");
		expect(mod.classifyHttpError(429, "slow down").kind).toBe("unavailable");
		expect(mod.classifyHttpError(503, "unavailable").kind).toBe("unavailable");
	});
});

describe("budgetPayload", () => {
	it("trims an over-limit set of files to fit the token budget", () => {
		const chars = 60_000;
		const sections = Array.from({ length: 10 }, (_, i) =>
			makeSection(i, chars),
		);
		const res = mod.budgetPayload(sections, "", "sys");

		// Some files fit, some were dropped.
		expect(res.diff.length).toBeGreaterThan(0);
		expect(res.diff.length).toBeLessThan(chars * sections.length);
		expect(res.omittedFiles.length).toBeGreaterThan(0);

		// The assembled input stays within budget.
		expect(res.estimatedInputTokens).toBeLessThanOrEqual(
			mod.INPUT_TOKEN_BUDGET,
		);
	});

	it("keeps a diff that already fits fully intact", () => {
		const sections = [makeSection(0, 1000), makeSection(1, 1000)];
		const res = mod.budgetPayload(sections, "", "sys");
		expect(res.omittedFiles).toHaveLength(0);
		expect(res.diff).toBe("d".repeat(2000));
	});

	it("drops everything and reports empty diff when even one file cannot fit", () => {
		const huge = mod.budgetPayload(
			[{ path: "big.ts", diff: "x".repeat(500_000) }],
			"",
			"sys",
		);
		expect(huge.diff).toBe("");
		expect(huge.omittedFiles).toContain("big.ts");
	});
});

describe("over-limit prompt handling", () => {
	it('posts "diff too large" — NOT "API unavailable" — when nothing fits', () => {
		const huge = mod.budgetPayload(
			[{ path: "big.ts", diff: "x".repeat(500_000) }],
			"",
			"sys",
		);
		expect(huge.diff.trim()).toBe(""); // triggers the diff-too-large branch in main()

		const body = mod.formatTooLargeBody(
			{ current: huge.estimatedInputTokens, limit: mod.INPUT_TOKEN_BUDGET },
			1,
		);
		expect(body).toContain("diff too large");
		expect(body).not.toContain("API unavailable");
	});

	it("callCerebras returns too_large (not apiError) on a 400 context_length_exceeded", async () => {
		const body = JSON.stringify({
			message:
				"Please reduce the length of the messages or completion. Current length is 136333 while limit is 131072",
			code: "context_length_exceeded",
		});
		globalThis.fetch = (async () =>
			new Response(body, { status: 400 })) as typeof globalThis.fetch;

		const res = await mod.callCerebras("test-key", "some diff", "", "");
		expect(res.apiError).toBe(false);
		expect(res.errorKind).toBe("too_large");
		expect(res.tokenInfo).toEqual({ current: 136333, limit: 131072 });
	});
});

describe("buildUserMessage ordering", () => {
	it("orders PR body before file context before the diff", () => {
		const msg = mod.buildUserMessage("DIFFTEXT", "CTXTEXT", "PRBODYTEXT");
		expect(msg.indexOf("PRBODYTEXT")).toBeGreaterThanOrEqual(0);
		expect(msg.indexOf("PRBODYTEXT")).toBeLessThan(msg.indexOf("CTXTEXT"));
		expect(msg.indexOf("CTXTEXT")).toBeLessThan(msg.indexOf("DIFFTEXT"));
	});
});
