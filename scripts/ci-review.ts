#!/usr/bin/env bun
/**
 * CI Code Review
 *
 * GitHub Actions workflow script: reads PR diff, calls Cerebras for review,
 * posts findings as a PR review comment. Safety net for code that bypasses
 * the wilco pre-push review pipeline.
 *
 * Usage:
 *   gh pr diff $PR_NUMBER | bun scripts/ci-review.ts
 *   bun scripts/ci-review.ts path/to/diff.txt
 *
 * Environment:
 *   CEREBRAS_API_KEY               — Cerebras API key (required in CI)
 *   GITHUB_REPOSITORY              — owner/repo (set by GitHub Actions)
 *   PR_NUMBER                      — pull request number
 *   CEREBRAS_MODEL                 — model override (default: zai-glm-4.7)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
	computeImpactScore,
	formatImpactScore,
	type ImpactScore,
} from "./lib/impact-score.js";
import { buildReviewPrompt, type ReviewFinding } from "./lib/review-prompt.js";

// ── Configuration ────────────────────────────────────────────────────────────

const CEREBRAS_ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "zai-glm-4.7";
const CI_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_CHARS = 400_000; // hard char cap on the raw diff (defense in depth)
const MAX_DIFF_SIZE = MAX_CONTEXT_CHARS; // kept as alias for parseDiff compat
const BUDGET_PER_FILE = 50_000; // cap individual file content in context
// Env-overridable so tests can disable the wait (CI_REVIEW_RETRY_DELAY_MS=0).
const RETRY_DELAY_MS = Number(process.env.CI_REVIEW_RETRY_DELAY_MS) || 2_000;
// One retry (2 attempts total). A retry triggered by finish_reason=length ESCALATES
// the completion budget (see nextCompletionBudget) instead of repeating the same
// request — a length-truncated reply fails identically if retried unchanged.
const MAX_RETRIES = 1;

// ── Token budgeting ──────────────────────────────────────────────────────────
// The model rejects the request (HTTP 400 context_length_exceeded) when the
// assembled prompt exceeds its context window. Char budgets alone can't prevent
// this: a diff well under MAX_CONTEXT_CHARS plus unbounded full-file context can
// still blow the token limit. So we estimate tokens and trim BEFORE sending.
const MODEL_CONTEXT_TOKENS = 131_072; // zai-glm-4.7 hard context window (input + output)
// zai-glm-4.7 is a REASONING model: its thinking tokens count against
// max_completion_tokens and are emitted BEFORE the answer. On a small diff the
// model can reason exhaustively through the 16 mandatory rules and exhaust the
// whole budget before writing a single character of JSON — the request returns
// finish_reason="length" with 0 content chars (observed on valors-mobile#255, a
// 1-file PR). The old 24576 cap sat below the observed reasoning length, so no
// JSON was ever produced and both identical retries failed the same way.
//
// Fix: the base budget sits comfortably ABOVE the model's reasoning length so the
// common case emits its JSON on the first attempt (finish_reason="stop"), and a
// length-truncated attempt ESCALATES toward MAX_COMPLETION_TOKENS_CEILING on retry
// rather than repeating the same request. Both are env-overridable.
const MAX_COMPLETION_TOKENS =
	Number(process.env.CI_REVIEW_MAX_COMPLETION_TOKENS) || 40_960;
// Ceiling the length-truncation retries climb toward. Holds GLM reasoning PLUS the
// JSON array for a normal PR while staying below the context window (a tiny PR's
// input is ~13K tokens, so 13K + 65536 << 131072).
const MAX_COMPLETION_TOKENS_CEILING =
	Number(process.env.CI_REVIEW_MAX_COMPLETION_TOKENS_CEILING) || 65_536;
// Conservative chars-per-token: real payloads have measured ~3.6 chars/token, so
// dividing by 3.5 slightly OVER-estimates token count — erring toward trimming.
const CHARS_PER_TOKEN = 3.5;
const TOKEN_SAFETY_FRACTION = 0.9; // only fill 90% of the context window
// Total input-token budget for system prompt + PR body + context + diff. The BASE
// completion budget is reserved up front; a length-truncation retry may escalate
// its completion budget above this reservation, in which case an already-large
// input can push the escalated attempt over the context window — that returns
// too_large and is reported accurately (a genuinely oversized review).
const INPUT_TOKEN_BUDGET =
	Math.floor(MODEL_CONTEXT_TOKENS * TOKEN_SAFETY_FRACTION) -
	MAX_COMPLETION_TOKENS;
const APPROVAL_COMMENT = "approved";
const TRUSTED_APPROVAL_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);

const DOC_EXTENSIONS = new Set([
	".md",
	".mdx",
	".txt",
	".rst",
	".adoc",
	".asciidoc",
	".wiki",
	".tex",
	".org",
	".rdoc",
	".textile",
]);

// ── Types ────────────────────────────────────────────────────────────────────
// ReviewFinding imported from shared module

// 'unavailable' — genuine reachability failure (5xx, network, timeout, missing/invalid key)
// 'too_large'   — payload exceeded the model context window (400 context_length_exceeded)
// 'client_error'— other 4xx: the request was rejected, but the API is reachable
// 'parse_error' — the API was reachable and returned 2xx, but the model's reply was
//                 truncated/malformed and no findings array could be parsed. This is
//                 NOT a clean "0 findings" review — the caller must fail loud.
type CerebrasErrorKind =
	| "unavailable"
	| "too_large"
	| "client_error"
	| "parse_error";

interface CerebrasResult {
	findings: ReviewFinding[];
	apiError: boolean; // true ONLY for genuine reachability failures ('unavailable')
	errorKind?: CerebrasErrorKind;
	tokenInfo?: { current: number; limit: number }; // parsed from a too_large response
}

interface DiffFileSection {
	path: string;
	diff: string;
}

interface DiffInfo {
	cleanDiff: string;
	sections: DiffFileSection[];
	isEmpty: boolean;
	isDocsOnly: boolean;
	wasTruncated: boolean;
	fileCount: number;
}

interface BudgetedPayload {
	diff: string;
	fileContext: string;
	omittedFiles: string[]; // files dropped from the diff to fit the token budget
	estimatedInputTokens: number;
	totalEstimatedTokens: number; // honest total cost of reviewing ALL candidate files
}

interface ManualApproval {
	author: string;
	association: string;
}

// Review patterns, prompt building, and FALLBACK_PROMPT imported from shared module

// ── Diff parsing ────────────────────────────────────────────────────────────

function parseDiff(rawDiff: string): DiffInfo {
	if (!rawDiff || !rawDiff.trim()) {
		return {
			cleanDiff: "",
			sections: [],
			isEmpty: true,
			isDocsOnly: false,
			wasTruncated: false,
			fileCount: 0,
		};
	}

	// Split into per-file sections
	const fileSections = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);
	const fileCount = fileSections.length;

	// Filter out binary files
	const textSections = fileSections.filter(
		(section) =>
			!section.includes("Binary files") &&
			!section.includes("GIT binary patch"),
	);

	// Check if docs-only
	const filePathRegex = /^diff --git a\/(.+?) b\//m;
	const allPaths = textSections
		.map((s) => s.match(filePathRegex)?.[1])
		.filter(Boolean) as string[];

	const isDocsOnly =
		allPaths.length > 0 &&
		allPaths.every((p) => {
			const ext = `.${p.split(".").pop()?.toLowerCase()}`;
			return DOC_EXTENSIONS.has(ext);
		});

	// Per-file sections (untruncated) drive token budgeting, so whole files can be
	// dropped and reported rather than blindly char-slicing mid-file.
	const sections: DiffFileSection[] = textSections.map((diff) => ({
		path: diff.match(filePathRegex)?.[1] || "unknown",
		diff,
	}));

	let cleanDiff = textSections.join("");
	let wasTruncated = false;

	if (cleanDiff.length > MAX_DIFF_SIZE) {
		cleanDiff = cleanDiff.slice(0, MAX_DIFF_SIZE);
		wasTruncated = true;
	}

	return {
		cleanDiff,
		sections,
		isEmpty: cleanDiff.trim().length === 0,
		isDocsOnly,
		wasTruncated,
		fileCount,
	};
}

// ── Full file context & token budgeting ──────────────────────────────────────

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildFileContextSection(filePath: string): string {
	if (DOC_EXTENSIONS.has(`.${filePath.split(".").pop()?.toLowerCase()}`))
		return "";
	try {
		const content = execFileSync("git", ["show", `HEAD:${filePath}`], {
			encoding: "utf-8",
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
		});
		const truncated =
			content.length > BUDGET_PER_FILE
				? `${content.slice(0, BUDGET_PER_FILE)}\n... (truncated)`
				: content;
		return `=== FILE: ${filePath} ===\n${truncated}`;
	} catch (e) {
		console.debug(
			`[ci-review] Could not read ${filePath} from HEAD, skipping:`,
			e,
		);
		return "";
	}
}

/**
 * Fit the review payload under the model's token budget.
 *
 * Priority: the diff is what we review, so per-file diff sections are included
 * first (in order) until the budget is exhausted; remaining files are omitted
 * and reported. Any leftover budget is spent on full-file context for the
 * included files (best-effort — context is dropped when it won't fit). The
 * system prompt and PR body are reserved up front so the assembled request
 * stays under MODEL_CONTEXT_TOKENS even after the model appends its completion.
 */
function budgetPayload(
	sections: DiffFileSection[],
	prBody = "",
	systemPrompt: string = REVIEW_PROMPT,
): BudgetedPayload {
	const WRAPPER_TOKENS = 64; // headings/labels added by buildUserMessage
	const fixedTokens =
		estimateTokens(systemPrompt) + estimateTokens(prBody) + WRAPPER_TOKENS;
	let remaining = INPUT_TOKEN_BUDGET - fixedTokens;

	const includedDiffs: string[] = [];
	const includedPaths: string[] = [];
	const omittedFiles: string[] = [];

	for (const { path, diff } of sections) {
		const cost = estimateTokens(diff);
		if (cost <= remaining) {
			includedDiffs.push(diff);
			includedPaths.push(path);
			remaining -= cost;
		} else {
			omittedFiles.push(path);
		}
	}

	// Spend whatever budget is left on full-file context for the included files.
	const contextSections: string[] = [];
	for (const path of includedPaths) {
		const section = buildFileContextSection(path);
		if (!section) continue;
		const cost = estimateTokens(section);
		if (cost <= remaining) {
			contextSections.push(section);
			remaining -= cost;
		}
	}

	// Honest total: fixed overhead plus EVERY candidate file's diff, so the
	// "too large" notice can report a `current` that truthfully exceeds the limit.
	const totalEstimatedTokens =
		fixedTokens +
		sections.reduce((sum, { diff }) => sum + estimateTokens(diff), 0);

	return {
		diff: includedDiffs.join(""),
		fileContext: contextSections.join("\n\n"),
		omittedFiles,
		estimatedInputTokens: INPUT_TOKEN_BUDGET - remaining,
		totalEstimatedTokens,
	};
}

// ── Cerebras API call ────────────────────────────────────────────────────────

const REVIEW_PROMPT = buildReviewPrompt();

function buildUserMessage(
	diff: string,
	fileContext: string,
	prBody = "",
): string {
	const parts: string[] = [];

	if (prBody) {
		parts.push("## PR Body\n\n");
		parts.push(prBody);
		parts.push("\n\n");
	}

	if (fileContext) {
		parts.push("## Full source files (for context)\n");
		parts.push(fileContext);
		parts.push("\n\n");
	}

	// The payload is token-budgeted upstream in budgetPayload(), so assemble as-is.
	parts.push("## Diff to review\n\n");
	parts.push(diff);

	return parts.join("");
}

// ── Manual approval comments ───────────────────────────────────────────────

function isApprovedComment(body: string | undefined): boolean {
	return (body || "").trim().toLowerCase() === APPROVAL_COMMENT;
}

function isTrustedApprovalAssociation(
	association: string | undefined,
): boolean {
	return TRUSTED_APPROVAL_ASSOCIATIONS.has(
		(association || "").trim().toUpperCase(),
	);
}

function getManualApprovalFromEnv(
	env: Record<string, string | undefined> = process.env,
): ManualApproval | null {
	if (env.GITHUB_EVENT_NAME !== "issue_comment") return null;
	if (env.COMMENT_IS_PR !== "true") return null;
	if (!isApprovedComment(env.COMMENT_BODY)) return null;
	if (!isTrustedApprovalAssociation(env.COMMENT_AUTHOR_ASSOCIATION))
		return null;

	return {
		author: env.COMMENT_AUTHOR || "unknown",
		association: (env.COMMENT_AUTHOR_ASSOCIATION || "").trim().toUpperCase(),
	};
}

/**
 * Classify a non-2xx Cerebras HTTP response. Distinguishes a payload that is too
 * large (400 context_length_exceeded — reachable API, our fault) from a genuine
 * availability failure (5xx, rate limit, invalid/expired key). Only the latter
 * should surface to users as "API unavailable".
 */
function classifyHttpError(
	status: number,
	body: string,
): { kind: CerebrasErrorKind; tokenInfo?: { current: number; limit: number } } {
	// Context-window overflow: the request reached the API but the prompt is too big.
	if (
		/context_length_exceeded/i.test(body) ||
		/reduce the length/i.test(body)
	) {
		const m = body.match(/current length is\s+(\d+)\s+while limit is\s+(\d+)/i);
		const tokenInfo = m
			? { current: Number(m[1]), limit: Number(m[2]) }
			: undefined;
		return { kind: "too_large", tokenInfo };
	}
	// Invalid/expired key (401/403) and rate limiting (429) are availability failures.
	if (status === 401 || status === 403 || status === 429)
		return { kind: "unavailable" };
	// Other 4xx: a rejected/malformed request — reachable API, so not "unavailable".
	if (status >= 400 && status < 500) return { kind: "client_error" };
	// 5xx and anything else: server-side / availability failure.
	return { kind: "unavailable" };
}

/**
 * Strip a single Markdown code fence (```json … ``` or ``` … ```) that wraps the
 * whole reply. Models sometimes fence the JSON despite the "no markdown fencing"
 * instruction, which broke the old greedy `[...]` match (the fence chars are not
 * part of a valid array). No fence → returned unchanged.
 */
function stripCodeFences(content: string): string {
	const trimmed = content.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Salvage the complete top-level `{...}` objects from a (possibly truncated) JSON
 * array body. Scans char-by-char tracking brace depth and string/escape state so a
 * reply cut off mid-array — missing its closing `]` and final object — still yields
 * the findings it *did* fully emit, rather than a total parse failure. A leading
 * object that is itself truncated contributes nothing (returns []).
 */
function salvageObjects(text: string): ReviewFinding[] {
	const findings: ReviewFinding[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				const slice = text.slice(start, i + 1);
				try {
					const obj = JSON.parse(slice);
					if (obj && typeof obj === "object" && !Array.isArray(obj)) {
						findings.push(obj as ReviewFinding);
					}
				} catch (e) {
					// A complete-braced span that still fails JSON.parse is malformed;
					// skip it but keep salvaging later objects.
					console.debug("[ci-review] salvage: skipping unparseable object:", e);
				}
				start = -1;
			}
		}
	}

	return findings;
}

/**
 * Parse the model's reply into findings. A well-behaved reply is a JSON array
 * (`[]` for no issues, or `[{...}]`). Robust to two real-world quirks: a reply
 * wrapped in a Markdown code fence, and a reply TRUNCATED by the token limit
 * (missing its closing `]`). We first strip fences and try a strict parse of the
 * first `[...]` block; on failure we SALVAGE every complete `{...}` object in
 * order so a truncated reply degrades to "the findings it produced" instead of a
 * total skip. Only when nothing parseable can be recovered is this a FAILURE —
 * distinguishing a broken response from a genuinely clean (`[]`) one. When the
 * result was salvaged from a truncated reply, `truncated: true` is set so the
 * caller can note the review is partial rather than treat it as a hard error.
 */
function parseFindings(
	content: string,
):
	| { ok: true; findings: ReviewFinding[]; truncated?: boolean }
	| { ok: false; error: string } {
	const cleaned = stripCodeFences(content);

	// Fast path: a well-formed `[...]` block that parses as an array.
	const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (Array.isArray(parsed))
				return { ok: true, findings: parsed as ReviewFinding[] };
		} catch (e) {
			console.debug("[ci-review] strict array parse failed, salvaging:", e);
		}
	}

	// Salvage path: parse each complete top-level object we can find. Anchor at the
	// opening `[` when present so trailing prose before the array is ignored.
	const openIdx = cleaned.indexOf("[");
	const body = openIdx === -1 ? cleaned : cleaned.slice(openIdx + 1);
	const salvaged = salvageObjects(body);
	if (salvaged.length > 0) {
		return { ok: true, findings: salvaged, truncated: true };
	}

	return {
		ok: false,
		error: jsonMatch
			? "response array was not valid JSON and no findings could be salvaged"
			: "no JSON array found in response",
	};
}

/**
 * Escalate the completion-token budget after a finish_reason="length" truncation.
 * Doubles the budget, capped at MAX_COMPLETION_TOKENS_CEILING, so a reply cut off
 * mid-reasoning (or mid-array) gets more room on the next attempt instead of the
 * retry repeating the same too-small request and failing identically.
 */
function nextCompletionBudget(current: number): number {
	return Math.min(current * 2, MAX_COMPLETION_TOKENS_CEILING);
}

async function callCerebras(
	apiKey: string,
	diff: string,
	fileContext: string,
	prBody = "",
): Promise<CerebrasResult> {
	let completionBudget = MAX_COMPLETION_TOKENS;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			console.log(
				`[ci-review] Retrying Cerebras API (attempt ${attempt + 1}, max_completion_tokens=${completionBudget})...`,
			);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CI_TIMEOUT_MS);

		try {
			const response = await fetch(CEREBRAS_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: CEREBRAS_MODEL,
					messages: [
						{ role: "system", content: REVIEW_PROMPT },
						{
							role: "user",
							content: buildUserMessage(diff, fileContext, prBody),
						},
					],
					temperature: 0.1,
					max_completion_tokens: completionBudget,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				console.error(
					`[ci-review] Cerebras API returned ${response.status}: ${body.slice(0, 200)}`,
				);
				const cls = classifyHttpError(response.status, body);
				// Payload/client errors are deterministic — retrying sends the same body,
				// so return immediately with an accurate error class instead of retrying.
				if (cls.kind === "too_large") {
					return {
						findings: [],
						apiError: false,
						errorKind: "too_large",
						tokenInfo: cls.tokenInfo,
					};
				}
				if (cls.kind === "client_error") {
					return { findings: [], apiError: false, errorKind: "client_error" };
				}
				if (attempt < MAX_RETRIES) continue;
				return { findings: [], apiError: true, errorKind: "unavailable" };
			}

			const data = (await response.json()) as {
				choices?: Array<{
					message?: { content?: string };
					finish_reason?: string;
				}>;
			};
			const choice = data.choices?.[0];
			const content = choice?.message?.content?.trim() || "";
			const finishReason = choice?.finish_reason;

			// Parse the reply, salvaging complete objects from a fenced or truncated
			// array. A reply with NOTHING parseable is a MALFORMED response, not a
			// clean "0 findings" review: retry, then surface parse_error so the caller
			// fails loud instead of posting a bogus empty approval.
			//
			// A completion truncated by the token limit (finish_reason "length") is
			// only fatal when salvage recovered nothing. If we salvaged >= 1 finding,
			// treat it as a successful — if partial — review rather than parse_error:
			// "the findings it did produce" beats a total skip that never approves.
			const parsed = parseFindings(content);
			const truncatedNoSalvage =
				finishReason === "length" &&
				(!parsed.ok || parsed.findings.length === 0);
			if (!parsed.ok || truncatedNoSalvage) {
				const reason = parsed.ok
					? "completion truncated (finish_reason=length), nothing salvageable"
					: parsed.error;
				console.error(
					`[ci-review] Cerebras reply was incomplete/unparseable (finish_reason=${finishReason ?? "?"}, ${content.length} chars): ${reason}`,
				);
				if (attempt < MAX_RETRIES) {
					// finish_reason=length means the reply hit the token ceiling: a retry
					// at the SAME budget truncates identically. Escalate the completion
					// budget so reasoning + JSON both fit. A genuine parse failure of a
					// COMPLETE reply (finish_reason=stop) won't be helped by more tokens,
					// so leave the budget unchanged for that case.
					if (finishReason === "length") {
						completionBudget = nextCompletionBudget(completionBudget);
					}
					continue;
				}
				return { findings: [], apiError: false, errorKind: "parse_error" };
			}

			if (finishReason === "length" || parsed.truncated) {
				console.warn(
					`[ci-review] Cerebras reply was truncated (finish_reason=${finishReason ?? "?"}); salvaged ${parsed.findings.length} complete finding(s) — review is PARTIAL.`,
				);
			}

			return {
				findings: parsed.findings.filter(
					(f) =>
						f.file &&
						f.severity &&
						f.category &&
						f.description &&
						[
							"critical",
							"high",
							"medium",
							"low",
							"needs-verification",
						].includes(f.severity),
				),
				apiError: false,
			};
		} catch (err: any) {
			if (err?.name === "AbortError") {
				console.error(
					`[ci-review] Cerebras API timed out (${CI_TIMEOUT_MS / 1000}s limit)`,
				);
			} else {
				console.error("[ci-review] Cerebras API error:", err?.message || err);
			}
			if (attempt < MAX_RETRIES) continue;
			return { findings: [], apiError: true, errorKind: "unavailable" };
		} finally {
			clearTimeout(timeout);
		}
	}

	return { findings: [], apiError: true, errorKind: "unavailable" };
}

// ── Review formatting ───────────────────────────────────────────────────────

function reviewEvent(
	findings: ReviewFinding[],
): "REQUEST_CHANGES" | "COMMENT" | "APPROVE" {
	const hasCriticalOrHigh = findings.some(
		(f) => f.severity === "critical" || f.severity === "high",
	);
	return hasCriticalOrHigh ? "REQUEST_CHANGES" : "APPROVE";
}

interface FormatOptions {
	wasTruncated: boolean;
	fileCount: number;
	omittedFiles?: string[];
	impactScore?: ImpactScore;
}

/**
 * Message posted when the diff cannot be reviewed because it exceeds the model
 * context window. Deliberately distinct from the "API unavailable" notice — the
 * API was reachable; the diff was simply too big.
 */
function formatTooLargeBody(
	tokenInfo: { current: number; limit: number },
	fileCount: number,
): string {
	return [
		"## Automated Code Review",
		"",
		`Automated review skipped -- diff too large (${tokenInfo.current} tokens > ${tokenInfo.limit} limit) across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
		"",
		"The change exceeds the model context window even after trimming. Consider splitting this PR into smaller, focused changes so it can be reviewed.",
		"",
		`An rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`,
	].join("\n");
}

/**
 * Message posted when the model returned a truncated/unparseable reply after
 * every retry. Distinct from the "API unavailable" notice — the API was
 * reachable, the reply just could not be parsed. Non-blocking: a maintainer can
 * re-run the check.
 */
function formatParseErrorBody(attempts: number): string {
	return [
		"## Automated Code Review",
		"",
		`Automated review skipped -- the model returned a truncated/unparseable response after ${attempts} attempt${attempts === 1 ? "" : "s"}. Merging is not blocked on this; a maintainer can re-run the check.`,
		"",
		`An rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`,
	].join("\n");
}

function formatReviewBody(
	findings: ReviewFinding[],
	opts: FormatOptions,
): string {
	const lines: string[] = [];
	lines.push("## Automated Code Review");
	lines.push("");
	lines.push(
		"> This review was generated by the wilco CI code review pipeline.",
	);
	lines.push("");

	if (opts.wasTruncated) {
		lines.push(
			`> **Note:** The PR diff was truncated (${opts.fileCount} files, exceeded ${MAX_DIFF_SIZE / 1000}KB limit). Some files may not have been reviewed.`,
		);
		lines.push("");
	}

	if (opts.omittedFiles?.length) {
		lines.push(
			`> **Note:** ${opts.omittedFiles.length} file(s) were omitted to fit the model context budget and were NOT reviewed: ${opts.omittedFiles
				.map((f) => `\`${f}\``)
				.join(", ")}.`,
		);
		lines.push("");
	}

	if (findings.length === 0) {
		lines.push("Code review passed -- no issues found.");
		if (opts.impactScore) {
			lines.push("");
			lines.push(formatImpactScore(opts.impactScore));
		}
		return lines.join("\n");
	}

	// Severity counts
	const counts: Record<string, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		"needs-verification": 0,
	};
	for (const f of findings) {
		counts[f.severity] = (counts[f.severity] || 0) + 1;
	}

	const nvCount = counts["needs-verification"];
	const nvSuffix = nvCount > 0 ? ` | Needs-verification: ${nvCount}` : "";
	lines.push(
		`**Summary:** Critical: ${counts.critical} | High: ${counts.high} | Medium: ${counts.medium} | Low: ${counts.low}${nvSuffix}`,
	);
	lines.push("");

	// Group findings by severity
	const severityOrder = [
		"critical",
		"high",
		"medium",
		"low",
		"needs-verification",
	] as const;
	for (const sev of severityOrder) {
		const sevFindings = findings.filter((f) => f.severity === sev);
		if (sevFindings.length === 0) continue;

		const icon =
			sev === "critical"
				? "!!!"
				: sev === "high"
					? "!!"
					: sev === "medium"
						? "!"
						: sev === "needs-verification"
							? "?"
							: ".";
		lines.push(`### ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${icon})`);
		lines.push("");

		for (const f of sevFindings) {
			lines.push(`- **${f.file}** (${f.line_range || "?"}): ${f.description}`);
			if (f.suggested_fix) {
				lines.push(`  - Fix: ${f.suggested_fix}`);
			}
		}
		lines.push("");
	}

	if (opts.impactScore) {
		lines.push(formatImpactScore(opts.impactScore));
	}

	return lines.join("\n");
}

// ── Get PR commit messages ──────────────────────────────────────────────────

function getPrCommitMessages(prNumber: string): string[] {
	try {
		const json = execFileSync(
			"gh",
			[
				"pr",
				"view",
				String(prNumber),
				"--json",
				"commits",
				"--jq",
				".commits[].messageHeadline",
			],
			{ encoding: "utf-8", timeout: 10_000 },
		);
		return json.trim().split("\n").filter(Boolean);
	} catch (err) {
		console.debug(
			`[ci-review] PR commit messages fetch failed for #${prNumber}:`,
			err,
		);
		return [];
	}
}

function getPrBody(prNumber: string): string {
	try {
		return execFileSync(
			"gh",
			["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"],
			{
				encoding: "utf-8",
				timeout: 5_000,
				maxBuffer: 200_000,
			},
		).trim();
	} catch (err) {
		console.warn(
			`[ci-review] PR body fetch failed for #${prNumber}: ${err instanceof Error ? err.message : err}`,
		);
		return "";
	}
}

// ── Post PR review via GitHub CLI ───────────────────────────────────────────

async function postPrReview(
	prNumber: string,
	repo: string,
	event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE",
	body: string,
): Promise<boolean> {
	try {
		const ghEvent = event === "APPROVE" ? "APPROVE" : event;
		const payload = JSON.stringify({ event: ghEvent, body });
		execFileSync(
			"gh",
			[
				"api",
				`repos/${repo}/pulls/${prNumber}/reviews`,
				"--method",
				"POST",
				"--input",
				"-",
			],
			{
				encoding: "utf-8",
				timeout: 15_000,
				input: payload,
			},
		);
		console.log(
			`[ci-review] Posted PR review (${event}) to ${repo}#${prNumber}`,
		);
		return true;
	} catch (err: any) {
		const stderr = err?.stderr ? `\n${String(err.stderr).trim()}` : "";
		console.error(
			`[ci-review] Failed to post PR review (${event}) to ${repo}#${prNumber}: ${err?.message || err}${stderr}`,
		);
		return false;
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const prNumber = process.env.PR_NUMBER;
	const repo = process.env.GITHUB_REPOSITORY;
	const apiKey = process.env.CEREBRAS_API_KEY;

	if (!prNumber || !repo) {
		console.error("[ci-review] PR_NUMBER and GITHUB_REPOSITORY must be set");
		process.exit(1);
	}

	if (process.env.GITHUB_EVENT_NAME === "issue_comment") {
		const manualApproval = getManualApprovalFromEnv();
		if (!manualApproval) {
			console.log(
				"[ci-review] Issue comment is not a trusted PR approval; skipping review.",
			);
			process.exit(0);
		}

		await postPrReview(
			prNumber,
			repo,
			"APPROVE",
			[
				"## Manual Code Review Approval",
				"",
				`Accepted \`${APPROVAL_COMMENT}\` comment from rc-int ${manualApproval.association.toLowerCase()} \`${manualApproval.author}\`.`,
				"",
				"This is the manual fallback for times when the Cerebras automated review is unavailable.",
			].join("\n"),
		);
		process.exit(0);
	}

	// Read diff from stdin or file argument
	let rawDiff = "";
	const diffArg = process.argv[2];
	if (diffArg && existsSync(diffArg)) {
		rawDiff = readFileSync(diffArg, "utf-8");
	} else {
		// Read from stdin (piped from gh pr diff)
		try {
			rawDiff = execFileSync("gh", ["pr", "diff", String(prNumber)], {
				encoding: "utf-8",
				maxBuffer: 5 * 1024 * 1024,
				timeout: 30_000,
			});
		} catch (err: any) {
			console.error(
				`[ci-review] Failed to get PR diff: ${err?.message || err}`,
			);
			process.exit(1);
		}
	}

	// Parse diff
	const diffInfo = parseDiff(rawDiff);

	if (diffInfo.isEmpty) {
		console.log("[ci-review] Empty diff, skipping review.");
		await postPrReview(
			prNumber,
			repo,
			"APPROVE",
			"## Automated Code Review\n\nNo changes to review — approved.",
		);
		process.exit(0);
	}

	if (diffInfo.isDocsOnly) {
		console.log("[ci-review] Docs-only changes, skipping code review.");
		await postPrReview(
			prNumber,
			repo,
			"APPROVE",
			"## Automated Code Review\n\nNo code changes to review (documentation only) — approved.",
		);
		process.exit(0);
	}

	if (!apiKey) {
		console.warn("[ci-review] CEREBRAS_API_KEY not set. Skipping review.");
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			`## Automated Code Review\n\nAutomated review skipped -- API unavailable.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`,
		);
		process.exit(0);
	}

	// Token-budget the payload BEFORE sending: include as many per-file diffs as
	// fit under the model context window, then spend leftover budget on full-file
	// context. Prevents the 400 context_length_exceeded that char budgets missed.
	const prBody = getPrBody(prNumber);
	const budget = budgetPayload(diffInfo.sections, prBody);

	if (budget.diff.trim().length === 0) {
		// Even a single file's diff exceeds the budget — nothing can be reviewed.
		console.warn(
			`[ci-review] Diff too large to review (est. ${budget.totalEstimatedTokens} tokens > ${INPUT_TOKEN_BUDGET} budget). Posting notice.`,
		);
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			formatTooLargeBody(
				{ current: budget.totalEstimatedTokens, limit: INPUT_TOKEN_BUDGET },
				diffInfo.fileCount,
			),
		);
		process.exit(0);
	}

	console.log(
		`[ci-review] Reviewing ${diffInfo.fileCount - budget.omittedFiles.length}/${diffInfo.fileCount} files (est. ${budget.estimatedInputTokens} input tokens, ${Math.round(budget.fileContext.length / 1000)}KB context)...`,
	);
	if (budget.omittedFiles.length) {
		console.warn(
			`[ci-review] Omitted ${budget.omittedFiles.length} file(s) to fit token budget: ${budget.omittedFiles.join(", ")}`,
		);
	}

	const result = await callCerebras(
		apiKey,
		budget.diff,
		budget.fileContext,
		prBody,
	);

	if (result.errorKind === "too_large") {
		// Belt-and-suspenders: the pre-send estimate was optimistic and the model
		// rejected the payload. Report accurately — the API was reachable.
		const limit = result.tokenInfo?.limit ?? INPUT_TOKEN_BUDGET;
		const current = result.tokenInfo?.current ?? budget.estimatedInputTokens;
		console.warn(
			"[ci-review] Cerebras rejected payload as too large. Posting diff-too-large notice.",
		);
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			formatTooLargeBody({ current, limit }, diffInfo.fileCount),
		);
		process.exit(0);
	}

	if (result.errorKind === "client_error") {
		console.warn(
			"[ci-review] Cerebras rejected the review request (client error). Posting notice.",
		);
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			`## Automated Code Review\n\nAutomated review skipped -- the review request was rejected by the model API.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`,
		);
		process.exit(0);
	}

	if (result.apiError) {
		console.warn("[ci-review] Cerebras API unavailable. Posting skip notice.");
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			`## Automated Code Review\n\nAutomated review skipped -- API unavailable.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`,
		);
		process.exit(0); // Don't fail the workflow on API issues
	}

	if (result.errorKind === "parse_error") {
		// The API was reachable but returned a truncated/unparseable review after
		// retries. Coercing it to an empty "0 findings" approval is the silent bug
		// we guard against — but hard-failing the check blocks every merge whenever
		// the model truncates. Keep the diagnostic loud in the logs, then post a
		// non-blocking skip notice (mirrors the apiError/client_error paths) so a
		// maintainer can re-run the check without the PR going red.
		console.error(
			`[ci-review] Unrecoverable: Cerebras returned an unparseable review for ${repo}#${prNumber} after ${MAX_RETRIES + 1} attempt(s). Posting a skip notice instead of an empty review.`,
		);
		await postPrReview(
			prNumber,
			repo,
			"COMMENT",
			formatParseErrorBody(MAX_RETRIES + 1),
		);
		process.exit(0); // Don't fail the workflow on a truncated model reply
	}

	const { findings } = result;

	// Compute impact score (non-blocking: failures don't affect review)
	let impactScore: ImpactScore | undefined;
	try {
		const commitMessages = getPrCommitMessages(prNumber);
		impactScore = computeImpactScore(
			diffInfo.cleanDiff,
			commitMessages,
			findings,
		);
		console.log(`[ci-review] Impact score: ${impactScore.total}/100`);
	} catch (err: any) {
		console.warn(
			`[ci-review] Impact score computation failed: ${err?.message || err}`,
		);
	}

	const event = reviewEvent(findings);
	const body = formatReviewBody(findings, {
		wasTruncated: diffInfo.wasTruncated,
		fileCount: diffInfo.fileCount,
		omittedFiles: budget.omittedFiles,
		impactScore,
	});

	const posted = await postPrReview(prNumber, repo, event, body);

	// Log summary
	const logCounts: Record<string, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		"needs-verification": 0,
	};
	for (const f of findings) {
		logCounts[f.severity] = (logCounts[f.severity] || 0) + 1;
	}
	console.log(
		`[ci-review] Review complete: ${findings.length} findings (critical=${logCounts.critical}, high=${logCounts.high}, medium=${logCounts.medium}, low=${logCounts.low}, needs-verification=${logCounts["needs-verification"]})`,
	);

	// A review was computed but posting it FAILED — the PR would otherwise show a
	// green check with no review attached (the silent-failure bug). Fail loud so the
	// missing review is visible instead of masked by exit 0.
	process.exit(posted ? 0 : 1);
}

// ── Exports for testing ─────────────────────────────────────────────────────

export {
	computeImpactScore,
	formatImpactScore,
	type ImpactScore,
} from "./lib/impact-score.js";
export type { ReviewFinding } from "./lib/review-prompt.js";
export {
	type BudgetedPayload,
	budgetPayload,
	buildReviewPrompt,
	buildUserMessage,
	type CerebrasErrorKind,
	type CerebrasResult,
	CI_TIMEOUT_MS,
	callCerebras,
	classifyHttpError,
	type DiffFileSection,
	type DiffInfo,
	estimateTokens,
	type FormatOptions,
	formatParseErrorBody,
	formatReviewBody,
	formatTooLargeBody,
	getManualApprovalFromEnv,
	getPrBody,
	getPrCommitMessages,
	INPUT_TOKEN_BUDGET,
	isApprovedComment,
	isTrustedApprovalAssociation,
	MAX_COMPLETION_TOKENS,
	MAX_COMPLETION_TOKENS_CEILING,
	MODEL_CONTEXT_TOKENS,
	nextCompletionBudget,
	parseDiff,
	parseFindings,
	postPrReview,
	reviewEvent,
	salvageObjects,
	stripCodeFences,
};

// Only run main when executed directly
if (!process.env.__CI_REVIEW_TEST) {
	main().catch((err) => {
		console.error("[ci-review] Fatal error:", err);
		process.exit(0); // Don't fail workflow on script errors
	});
}
