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
		expect(huge.totalEstimatedTokens).toBeGreaterThan(mod.INPUT_TOKEN_BUDGET);

		const body = mod.formatTooLargeBody(
			{ current: huge.totalEstimatedTokens, limit: mod.INPUT_TOKEN_BUDGET },
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

describe("parseFindings", () => {
	it("treats an empty array as a clean, well-formed 0-findings review", () => {
		const res = mod.parseFindings("[]");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.findings).toHaveLength(0);
	});

	it("parses a well-formed findings array", () => {
		const res = mod.parseFindings(
			'prose... [{"file":"a.ts","severity":"high","category":"bug","description":"x","suggested_fix":"y","line_range":"1-2"}] trailing',
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.findings).toHaveLength(1);
	});

	it("reports a FAILURE (not empty findings) when the reply is truncated with no closing bracket", () => {
		// The real incident: the model's reply was cut off mid-array. Old behaviour
		// coerced this to `[]` (0 findings, green approve). It must now be a failure.
		const res = mod.parseFindings('[{"file":"a.ts","severity":"hig');
		expect(res.ok).toBe(false);
	});

	it("reports a FAILURE when a bracketed span is present but not valid JSON", () => {
		const res = mod.parseFindings('[{"file": "a.ts", severity: high}]');
		expect(res.ok).toBe(false);
	});
});

describe("callCerebras parse handling", () => {
	it("returns parse_error (NOT a clean 0-findings review) on a truncated completion", async () => {
		// 2xx response whose message content is a truncated JSON array. Old code
		// returned { findings: [], apiError: false } — indistinguishable from a real
		// "no issues" review. It must now surface errorKind: "parse_error".
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: { content: '[{"file":"a.ts","severity":"hig' },
							finish_reason: "length",
						},
					],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const res = await mod.callCerebras("test-key", "some diff", "", "");
		expect(res.findings).toHaveLength(0);
		expect(res.apiError).toBe(false);
		expect(res.errorKind).toBe("parse_error");
	});

	it("returns a clean review (no errorKind) when the model legitimately reports no issues", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{ message: { content: "[]" }, finish_reason: "stop" },
					],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const res = await mod.callCerebras("test-key", "some diff", "", "");
		expect(res.findings).toHaveLength(0);
		expect(res.apiError).toBe(false);
		expect(res.errorKind).toBeUndefined();
	});
});

describe("postPrReview failure signalling", () => {
	it("returns false when the gh review POST fails (main() maps this to exit 1)", async () => {
		// Force `gh` to be unresolvable so execFileSync throws — a deterministic,
		// offline stand-in for a failed review POST. postPrReview must report false
		// so main() exits non-zero instead of a green check with no review.
		const origPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const ok = await mod.postPrReview("87", "owner/repo", "COMMENT", "body");
			expect(ok).toBe(false);
		} finally {
			process.env.PATH = origPath;
		}
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
