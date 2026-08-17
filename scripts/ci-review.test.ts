// Tests for the CI code-review script's token budgeting and error classification.
//
// Focus: a diff that overflows the model context window must be TRIMMED before
// sending, and — if it still cannot fit — reported as "diff too large", never as
// "API unavailable" (which is reserved for genuine reachability failures).

import { afterEach, beforeAll, describe, expect, it } from "bun:test";

// Suppress main() (which does network + gh calls + process.exit) on import.
process.env.__CI_REVIEW_TEST = "1";
// Disable the inter-attempt retry delay so escalation/parse_error tests don't wait.
process.env.CI_REVIEW_RETRY_DELAY_MS = "0";

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

	it("callReviewModel returns too_large (not apiError) on a 400 context_length_exceeded", async () => {
		const body = JSON.stringify({
			message:
				"Please reduce the length of the messages or completion. Current length is 136333 while limit is 131072",
			code: "context_length_exceeded",
		});
		globalThis.fetch = (async () =>
			new Response(body, { status: 400 })) as typeof globalThis.fetch;

		const res = await mod.callReviewModel("test-key", "some diff", "", "");
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

	it("reports a FAILURE (not empty findings) when the reply is truncated with no salvageable object", () => {
		// The real incident: the model's reply was cut off mid-FIRST-object, so there
		// is no complete `{...}` to salvage. Old behaviour coerced a `[...]`-less reply
		// to `[]` (0 findings, green approve). It must remain a failure.
		const res = mod.parseFindings('[{"file":"a.ts","severity":"hig');
		expect(res.ok).toBe(false);
	});

	it("reports a FAILURE when a bracketed span is present but not valid JSON", () => {
		const res = mod.parseFindings('[{"file": "a.ts", severity: high}]');
		expect(res.ok).toBe(false);
	});

	it("strips a ```json code fence around the array before parsing", () => {
		const fenced =
			'```json\n[{"file":"a.ts","severity":"low","category":"x","description":"d","suggested_fix":"f","line_range":"1"}]\n```';
		const res = mod.parseFindings(fenced);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.findings).toHaveLength(1);
	});

	it("strips a bare ``` code fence around the array before parsing", () => {
		const fenced = "```\n[]\n```";
		const res = mod.parseFindings(fenced);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.findings).toHaveLength(0);
	});

	it("ignores trailing prose after the closing bracket", () => {
		const res = mod.parseFindings(
			'[{"file":"a.ts","severity":"high","category":"bug","description":"x","suggested_fix":"y","line_range":"1"}]\n\nThat concludes my review.',
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.findings).toHaveLength(1);
	});

	it("salvages the complete leading objects from a truncated array missing its final ]", () => {
		// Two complete finding objects, then a third cut off mid-value with no closing
		// brace or `]`. Salvage must return the two complete ones and flag truncated.
		const truncated =
			'[{"file":"a.ts","severity":"high","category":"bug","description":"first","suggested_fix":"f1","line_range":"1"},' +
			'{"file":"b.ts","severity":"medium","category":"perf","description":"second","suggested_fix":"f2","line_range":"2"},' +
			'{"file":"c.ts","severity":"lo';
		const res = mod.parseFindings(truncated);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.findings).toHaveLength(2);
			expect(res.findings[0].file).toBe("a.ts");
			expect(res.findings[1].file).toBe("b.ts");
			expect(res.truncated).toBe(true);
		}
	});

	it("does not split on braces inside string values when salvaging", () => {
		// A description containing `{` / `}` must not confuse the brace scanner.
		const truncated =
			'[{"file":"a.ts","severity":"high","category":"bug","description":"uses object literal {x: 1}","suggested_fix":"f","line_range":"1"},' +
			'{"file":"b.ts","severity":"lo';
		const res = mod.parseFindings(truncated);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.findings).toHaveLength(1);
			expect(res.findings[0].description).toContain("{x: 1}");
		}
	});
});

describe("stripCodeFences", () => {
	it("returns non-fenced content unchanged (trimmed)", () => {
		expect(mod.stripCodeFences("  [] ")).toBe("[]");
	});
	it("unwraps a ```json fence", () => {
		expect(mod.stripCodeFences("```json\n[1]\n```")).toBe("[1]");
	});
	it("unwraps a bare ``` fence", () => {
		expect(mod.stripCodeFences("```\n[2]\n```")).toBe("[2]");
	});
});

describe("salvageObjects", () => {
	it("returns [] when the leading object is truncated", () => {
		expect(mod.salvageObjects('{"file":"a.ts","sev')).toHaveLength(0);
	});
	it("returns each complete object before a truncation point", () => {
		const body =
			'{"file":"a.ts","severity":"high","category":"c","description":"d","suggested_fix":"f","line_range":"1"},{"file":"b.ts","sev';
		const objs = mod.salvageObjects(body);
		expect(objs).toHaveLength(1);
		expect(objs[0].file).toBe("a.ts");
	});
});

describe("readIntEnv", () => {
	const KEY = "CI_REVIEW_TEST_INT_ENV";
	afterEach(() => {
		delete process.env[KEY];
	});

	it("returns the fallback when the env var is unset", () => {
		expect(mod.readIntEnv(KEY, 2_000, 0)).toBe(2_000);
	});
	it("honours a deliberate 0 when min is 0 (the retry-delay case that `||` broke)", () => {
		process.env[KEY] = "0";
		expect(mod.readIntEnv(KEY, 2_000, 0)).toBe(0);
	});
	it("parses a positive integer override", () => {
		process.env[KEY] = "50000";
		expect(mod.readIntEnv(KEY, 40_960, 1)).toBe(50_000);
	});
	it("falls back on a value below min (e.g. 0 tokens) or a non-number", () => {
		process.env[KEY] = "0";
		expect(mod.readIntEnv(KEY, 40_960, 1)).toBe(40_960);
		process.env[KEY] = "not-a-number";
		expect(mod.readIntEnv(KEY, 40_960, 1)).toBe(40_960);
	});
});

describe("CI_TIMEOUT_MS", () => {
	const KEY = "CI_REVIEW_TIMEOUT_MS";
	afterEach(() => {
		delete process.env[KEY];
	});

	it("defaults to 180000 ms (3 min) when CI_REVIEW_TIMEOUT_MS is unset", () => {
		// The env var is unset at import time, so the exported constant holds the
		// raised default — confirming the 60s → 180s bump.
		expect(mod.CI_TIMEOUT_MS).toBe(180_000);
	});
	it("is env-overridable via CI_REVIEW_TIMEOUT_MS through readIntEnv", () => {
		// The module derives CI_TIMEOUT_MS from readIntEnv(KEY, 180_000, 1_000);
		// exercise that binding directly since the constant is read once at import.
		process.env[KEY] = "300000";
		expect(mod.readIntEnv(KEY, 180_000, 1_000)).toBe(300_000);
	});
	it("floors out sub-1000ms overrides back to the default", () => {
		process.env[KEY] = "500";
		expect(mod.readIntEnv(KEY, 180_000, 1_000)).toBe(180_000);
	});
});

describe("nextCompletionBudget", () => {
	it("never lets the ceiling drop below the base budget", () => {
		// Clamp invariant: even a misconfigured lower ceiling env can't make an
		// escalation shrink the budget.
		expect(mod.MAX_COMPLETION_TOKENS_CEILING).toBeGreaterThanOrEqual(
			mod.MAX_COMPLETION_TOKENS,
		);
	});
	it("doubles the budget on a length truncation", () => {
		expect(mod.nextCompletionBudget(mod.MAX_COMPLETION_TOKENS)).toBe(
			Math.min(mod.MAX_COMPLETION_TOKENS * 2, mod.MAX_COMPLETION_TOKENS_CEILING),
		);
	});
	it("caps at the ceiling and never exceeds it", () => {
		expect(mod.nextCompletionBudget(mod.MAX_COMPLETION_TOKENS_CEILING)).toBe(
			mod.MAX_COMPLETION_TOKENS_CEILING,
		);
		expect(
			mod.nextCompletionBudget(mod.MAX_COMPLETION_TOKENS_CEILING * 10),
		).toBe(mod.MAX_COMPLETION_TOKENS_CEILING);
	});
});

describe("callReviewModel parse handling", () => {
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

		const res = await mod.callReviewModel("test-key", "some diff", "", "");
		expect(res.findings).toHaveLength(0);
		expect(res.apiError).toBe(false);
		expect(res.errorKind).toBe("parse_error");
	});

	it("treats a length-truncated reply with a salvageable finding as a partial success (no parse_error)", async () => {
		// finish_reason "length" but the reply contains one COMPLETE finding object
		// before the cut. It must degrade to a partial review (the salvaged finding),
		// not a parse_error skip that never approves.
		const truncated =
			'[{"file":"a.ts","severity":"high","category":"bug","description":"real issue","suggested_fix":"fix it","line_range":"1"},' +
			'{"file":"b.ts","severity":"lo';
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{ message: { content: truncated }, finish_reason: "length" },
					],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const res = await mod.callReviewModel("test-key", "some diff", "", "");
		expect(res.errorKind).toBeUndefined();
		expect(res.apiError).toBe(false);
		expect(res.findings).toHaveLength(1);
		expect(res.findings[0].file).toBe("a.ts");
	});

	it("escalates max_completion_tokens after a finish_reason=length, 0-char reply and succeeds on retry", async () => {
		// The exact valors-mobile#255 incident: a tiny PR whose whole completion
		// budget is consumed by GLM reasoning tokens, so the first reply is
		// finish_reason=length with 0 content chars. The old code retried the SAME
		// budget and truncated identically → parse_error skip. It must now ESCALATE
		// the completion budget on the retry and parse the (now complete) reply.
		const budgets: number[] = [];
		let call = 0;
		globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
			budgets.push(JSON.parse(init.body).max_completion_tokens);
			call++;
			if (call === 1) {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "" }, finish_reason: "length" }],
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "[]" }, finish_reason: "stop" }],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof globalThis.fetch;

		const res = await mod.callReviewModel("test-key", "tiny diff", "", "");
		expect(res.errorKind).toBeUndefined();
		expect(res.apiError).toBe(false);
		expect(res.findings).toHaveLength(0);
		// Two attempts, and the second used a STRICTLY LARGER completion budget.
		expect(budgets).toHaveLength(2);
		expect(budgets[0]).toBe(mod.MAX_COMPLETION_TOKENS);
		expect(budgets[1]).toBeGreaterThan(budgets[0]);
	});

	it("does NOT escalate the budget when a COMPLETE reply (finish_reason=stop) fails to parse", async () => {
		// More tokens can't fix malformed-but-complete JSON, so a stop-truncated
		// parse failure must retry at the SAME budget, then surface parse_error.
		const budgets: number[] = [];
		globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
			budgets.push(JSON.parse(init.body).max_completion_tokens);
			return new Response(
				JSON.stringify({
					choices: [
						{ message: { content: "not json at all" }, finish_reason: "stop" },
					],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof globalThis.fetch;

		const res = await mod.callReviewModel("test-key", "some diff", "", "");
		expect(res.errorKind).toBe("parse_error");
		expect(budgets).toHaveLength(2);
		expect(budgets[1]).toBe(budgets[0]); // unchanged — no escalation
	});

	it("returns a clean review (no errorKind) when the model legitimately reports no issues", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "[]" }, finish_reason: "stop" }],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const res = await mod.callReviewModel("test-key", "some diff", "", "");
		expect(res.findings).toHaveLength(0);
		expect(res.apiError).toBe(false);
		expect(res.errorKind).toBeUndefined();
	});
});

describe("parse_error soft-fail notice", () => {
	it("posts a non-blocking skip notice — NOT a red check — on a truncated reply", () => {
		// Regression guard: main() used to process.exit(1) on errorKind ===
		// "parse_error", turning the check red and blocking every merge whenever the
		// model truncated. It now posts formatParseErrorBody as a COMMENT and exits 0.
		const body = mod.formatParseErrorBody(2); // MAX_RETRIES (1) + 1 attempt
		expect(body).toContain("truncated/unparseable");
		expect(body).toContain("Merging is not blocked on this");
		// Must NOT masquerade as the other, distinct skip notices.
		expect(body).not.toContain("API unavailable");
		expect(body).not.toContain("diff too large");
	});

	it("pluralises the attempt count from MAX_RETRIES + 1", () => {
		expect(mod.formatParseErrorBody(1)).toContain("after 1 attempt.");
		expect(mod.formatParseErrorBody(2)).toContain("after 2 attempts.");
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
