/**
 * Shared review prompt builder.
 *
 * Single source of truth for diff review prompts used by:
 * - pre-push session review (Cerebras)
 * - CI code review (Groq)
 * - session-end structured review (Haiku)
 *
 * All prompts are built from templates/review-patterns.yaml.
 * Field names use snake_case to match the review_findings DB table.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewFinding {
	file: string;
	severity: "critical" | "high" | "medium" | "low" | "needs-verification";
	category: string;
	description: string;
	suggested_fix: string;
	line_range: string;
}

export interface ReviewPattern {
	name: string;
	severity: string;
	description: string;
}

export interface ReviewPatterns {
	version: number;
	categories: Record<string, { patterns: ReviewPattern[] }>;
	"additional-checks": ReviewPattern[];
	"severity-guide": Record<string, string>;
	"review-rules"?: string[];
	"review-process"?: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_YAML_PATH = join(
	__dirname,
	"..",
	"..",
	"templates",
	"review-patterns.yaml",
);

const CATEGORY_TITLES: Record<string, string> = {
	security: "Security",
	"error-handling": "Error handling",
	configuration: "Configuration",
	"data-integrity": "Data integrity",
};

/**
 * Required sections in a PR body, per docs/glossary.md "PR" recipe step 10.
 * Used by the PR-structure check to flag missing or vague sections.
 */
export const PR_BODY_REQUIRED_SECTIONS = [
	"## Summary",
	"## Changes",
	"## Test Plan",
] as const;

export const PR_BODY_CONDITIONAL_SECTIONS = [
	"## Operator Deploy Steps", // required if PR touches production
	"## Expected Outcomes", // required on non-trivial PRs
] as const;

/**
 * Reusable PR-structure rule, injected into both buildReviewPrompt() and FALLBACK_PROMPT
 * so the prompt content is identical regardless of YAML availability.
 */
export const PR_STRUCTURE_RULE = `### PR structure
When the user message contains a \`## PR Body\` block, evaluate the PR body against the structure required by \`docs/glossary.md\` "PR" recipe step 10. The PR body MUST contain:
- \`## Summary\` (always)
- \`## Changes\` (always)
- \`## Test Plan\` (always)
- \`## Operator Deploy Steps\` (required if the diff touches production code: fleet scripts, services, scheduled jobs, infra, schemas, CI workflows)
- \`## Expected Outcomes\` (required on non-trivial PRs — anything bigger than a typo)

Flag as HIGH severity:
- Missing required section
- \`## Operator Deploy Steps\` items that are vague (e.g. "deploy somehow", "rsync to fleet" with no command, "restart the service" with no service name)
- \`## Expected Outcomes\` items without verifiable acceptance criteria (e.g. "verify it works", "should be fine", no \`- [ ]\` checklist)
- \`## Test Plan\` post-merge items (\`- [ ]\`) that are not runnable commands

The finding's \`file\` field for these checks is the literal string \`PR_BODY\` (not a source file path), and \`line_range\` is the section name (e.g. "## Operator Deploy Steps").`;

/**
 * Mandatory engineering rules, injected alongside PR_STRUCTURE_RULE into both
 * buildReviewPrompt() and FALLBACK_PROMPT. Encodes the team's most frequently
 * repeated review-finding categories so violations surface as HIGH severity
 * (which triggers REQUEST_CHANGES and blocks merge).
 */
export const ENGINEERING_RULES = `### Engineering rules (mandatory — flag violations as HIGH)

Diff scope: only flag code on ADDED lines (lines beginning with \`+\`, excluding the \`+++\` file header). Do NOT flag issues visible only on context lines (single leading space) or removed lines (\`-\`) — those are pre-existing or being deleted and are out of scope. If a pre-existing issue appears only in surrounding context, ignore it.

Evaluate the diff against the rules below. For ANY real violation visible in the diff, emit a finding with severity "high" (or "critical" for an issue that can take down a shared service or cause data loss) citing the exact file and line — a HIGH finding triggers REQUEST_CHANGES and blocks the merge until fixed. These encode the team's most frequently-repeated review findings. IMPORTANT: only flag what the changed lines actually show; do not invent violations or flag a rule that does not apply to this diff.

1. Unverified assumptions. HIGH when: code, comments, log lines, or messages assert a fact or number with no basis (e.g. throughput like "235 records/hour", "this is correct", "the migration is broken") as if verified; or a calculation uses unverified inputs but is stated as a precise result instead of an estimate.

2. Silent error handling. HIGH when: an empty or log-less catch — \`catch {}\`, \`catch (e) {}\` with no body, \`.catch(() => {})\`, Python \`except ...: pass\` or bare \`except:\` — swallows an error without at least a debug log that includes the error.

3. Missing timeouts on I/O. HIGH when: \`fetch\`, \`net.connect\`, \`axios\`, Python \`requests\`, an upstream/proxy call, or a potentially-slow DB query is issued with no timeout/abort. Also flag direct access to external/parsed data (dict keys, indices) that can throw with no guard.

4. Hardcoded environment-specific values. HIGH when: a hardcoded user-specific path (\`/home/<name>/...\`), IP address, port, channel/ID, or secret/token appears in source; or a magic number is used in non-trivial logic instead of a named constant.

5. Security. HIGH when: TLS/host verification is disabled (\`NODE_TLS_REJECT_UNAUTHORIZED = '0'\`, \`verify=False\`, \`StrictHostKeyChecking=accept-new\`); SQL is built by string concatenation / f-string instead of a parameterized query; a new HTTP route/handler has no auth check; or credentials are read from an insecure location. Exception — test-fixture secrets: do NOT flag hardcoded credentials, passwords, API keys, or tokens that appear in test code or fixtures (files whose path contains \`test\`, \`tests\`, \`__tests__\`, \`spec\`, or \`fixtures\`, or values explicitly annotated as test-only) — these are intentional test data, not real secret leaks. Real credentials in non-test production source must still be flagged.

6. Missing tests. HIGH when: a new script, module, or worker — or substantial new logic — is added with no corresponding test file or test case in the same diff.

7. Production-path changes without a verification story. HIGH when: the diff touches deploy scripts, systemd units, CI workflows, DB schemas/migrations, scheduled jobs, or multi-tenant infra AND the \`## PR Body\` lacks concrete \`## Operator Deploy Steps\` and \`## Expected Outcomes\` containing at least one runnable post-deploy smoke/health command.

8. Dead, duplicated, or truncated code. HIGH when: a logic block is duplicated verbatim (DRY violation); a file ends mid-statement or mid-comment (truncated edit); or code is plainly unreachable. EXCEPTION — duplicate imports: cap any finding about a duplicated or re-declared import at MEDIUM (never HIGH). A genuine duplicate import is already caught deterministically by the ruff lint gate (F811, redefinition of unused name), which blocks the merge on its own — so the reviewer must not also block on it, and a mistaken duplicate-import claim must never block a merge.

9. Bash set -e safety. HIGH when: in a script using \`set -e\` / \`set -euo pipefail\`, an optional command (a \`grep\` that may match nothing, an optional tool) is invoked without \`|| true\` or an \`if\` guard.

10. Heavy query on a shared service pool. HIGH (CRITICAL if it can invalidate a shared connection/engine for other callers): the diff adds a \`COUNT(DISTINCT ...)\`, a full-table scan, a large window/dedup, or any unbounded aggregation to a SHARED, memory-constrained request path (an HTTP API handler, a shared DB/DuckDB connection pool). A query that fits when run alone can OOM under concurrency and break the service for everyone. Prefer isolating it in its own process with its own memory_limit, or precomputing into a small materialized table.

11. COUNT(DISTINCT) over large data in a hot path. HIGH: a \`COUNT(DISTINCT key)\` (or several with FILTERs) over a large or append-only history table inside an API/report/request path — it builds a hash set sized to the cardinality and cannot exploit row ordering. Materialize current-state (one row per key) and use \`COUNT(*) FILTER (...)\` instead.

12. Scheduled job not verified in its real execution context. HIGH: the diff adds or changes a scheduled job (a cron entry, a systemd \`.timer\`/\`.service\`, a scheduled script/worker) and the \`## PR Body\` shows no evidence it was verified in the ACTUAL execution context (the cron/systemd environment, the real \`User=\`) rather than only an interactive shell. Interactive-only verification misses env/SSH-agent/sudo/PATH/tty differences that break the scheduled run.

13. A scheduled job or report that does not fail loud. HIGH: a report or scheduled job that, on a backend error or an empty/zero result, still emits output (renders a zeros/empty table, posts a message, writes a record) instead of exiting non-zero and emitting nothing. An HTTP \`200\` or \`rc=0\` is not proof of data — validate the rows/payload before acting; emitting garbage on failure is worse than skipping the run.

14. Merge-automation that ignores strict branch protection. HIGH: the diff adds or changes auto-merge / merge-automation CI (e.g. a workflow arming \`gh pr merge --auto\`) without accounting for \`strict\` ("require branch up to date") protection — under which a PR falls BEHIND when main moves and auto-merge will NOT fire until the branch is updated (needs an update-branch step or a merge queue).

15. English-only string sets in a multilingual codebase. CRITICAL when: a whitelist, category list, keyword filter, allowlist, or any hardcoded string set used to match/gate/route data is English-only while the code processes multilingual data (e.g. a fleet whose sources return Portuguese/Spanish). An English-only match silently drops non-English records — this is data loss, not a missed feature — so verify locale coverage of every hardcoded string set.

16. Unbounded logs. HIGH when: a new or modified app, service, script, cron job, or container writes a log with no size bound or rotation — no logrotate stanza (\`copytruncate\` for a writer that holds the fd open, \`create\` for one that reopens per run), no docker \`log-opts\` \`max-size\`/\`max-file\`, no journald \`SystemMaxUse\`, or a home-grown rotation that a short-lived / cron process never fires. Every log must have a size cap and retention.

17. Severity calibration. Assign the band that matches the ACTUAL impact of the changed lines:
- critical: an exploitable security vulnerability, data loss/corruption, or a guaranteed crash / broken build on the primary path.
- high: a likely-exploitable security issue; a correctness bug that yields wrong output; an unhandled failure on a common path; OR a coverage gap (see rule 18).
- medium: a correctness issue on an edge case, a resource leak, missing error handling on a non-critical path, a performance concern.
- low: style, naming, minor maintainability, docs.
Do not inflate severity to force attention, and do not deflate a real security, correctness, or coverage issue. Pick the band that matches actual impact.

18. Coverage carve-out (mandatory, non-negotiable — overrides rule 17's "don't inflate"). Missing or inadequate unit tests for substantial new logic are ALWAYS at least \`high\` and therefore blocking — including for scripts, tooling, and CI/eval code — because some repositories auto-merge on green CI with no human review gate. Never downgrade a genuine coverage gap below \`high\`, and never render it as a non-blocking note.

19. Context accuracy. Be precise about what is and isn't covered. If related logic is already tested in a sibling file present in the diff, acknowledge it and flag only the specific untested surface — do not claim "no tests exist" when some do.

20. Remediation quality. Only propose a fix that is specific to the code under review and that you have reasoned is genuinely valuable. Do not emit a generic remediation (e.g. "add tests", "mock the API") without naming the concrete behavior that must be covered and why. If you cannot identify a valuable, concrete fix, describe the gap and its risk instead of prescribing a hollow one.`;

/**
 * Standardized output schema description for all diff review prompts.
 * Uses snake_case to match review_findings DB columns.
 */
export const REVIEW_OUTPUT_SCHEMA = `Output ONLY a JSON array of findings. Each finding must have:
- "file": the filename from the diff
- "severity": "critical" | "high" | "medium" | "low" | "needs-verification"
- "category": short category name (e.g. "security", "error-handling", "testing", "logging", "hardcoded-value", "dead-code", "config", "data-integrity")
- "description": concise description of the issue
- "suggested_fix": brief suggestion for how to fix it
- "line_range": approximate line range from the diff (e.g. "+42-+55")`;

// ── YAML loader ──────────────────────────────────────────────────────────────

export function loadReviewPatterns(yamlPath?: string): ReviewPatterns | null {
	const path = yamlPath || DEFAULT_YAML_PATH;
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf-8");
		return YAML.parse(raw) as ReviewPatterns;
	} catch (err) {
		console.warn(
			`[review-prompt] Failed to load review patterns from ${path}:`,
			err,
		);
		return null;
	}
}

// ── Fallback prompt ──────────────────────────────────────────────────────────

export const FALLBACK_PROMPT = `You are a senior code reviewer. You will receive the full source files for context followed by the git diff to review. Use the full file context to understand the broader codebase patterns, existing error handling, and architecture before flagging issues in the diff.

## Diff scope (highest priority — read before everything else)
Scope every finding to the changes in this diff. Only report a problem if the offending code is on an ADDED line (a line beginning with \`+\` in the unified diff, excluding the \`+++\` file header). Do NOT flag issues that appear only on context lines (lines beginning with a single space) or removed lines (beginning with \`-\`) — that code is pre-existing or being deleted and is out of scope for this review. If a pre-existing issue is visible only in surrounding context, ignore it.

## Review rules (non-negotiable)
- Do NOT skip review when issues are found — continue and report ALL findings
- Do NOT make assumptions without evidence from the diff
- Every finding must reference the specific file and code as evidence
- Prefer fewer high-quality findings over many weak ones
- If something looks wrong but unclear, flag severity as 'needs-verification'

## Review process
1. Understand the change: read the full diff to grasp intent before judging
2. Systematic review: check each category in the patterns list
3. Evidence gathering: for each finding, cite the exact file and line range
4. Severity assignment: only flag critical/high when evidence is clear

## Critical patterns (always flag as critical or high)

### Security
- Hardcoded credentials, API keys, passwords, or connection strings with auth info (exception: do NOT flag hardcoded credentials, passwords, API keys, or tokens in test code or fixtures — files whose path contains \`test\`, \`tests\`, \`__tests__\`, \`spec\`, or \`fixtures\`, or values explicitly annotated as test-only — these are intentional test data, not real secret leaks; real credentials in non-test production source must still be flagged)
- SQL/command injection: string concatenation in queries instead of parameterized
- Client-supplied userId/auth context trusted without server-side derivation
- Missing auth checks on endpoints
- Secrets logged or exposed in error messages

### Error handling
- Empty catch blocks: \`catch {}\`, \`catch { /* comment */ }\`, \`.catch(() => {})\`
- \`except Exception: pass\` or \`except: pass\` in Python
- Errors swallowed without any logging (at minimum console.debug)
- Missing error context: catch logs a generic message without the error object

### Test coverage and context
- Coverage carve-out (mandatory, non-negotiable): missing or inadequate unit tests for substantial new logic are ALWAYS at least \`high\` and therefore blocking — including for scripts, tooling, and CI/eval code — because some repositories auto-merge on green CI with no human review gate. Never downgrade a genuine coverage gap below \`high\`, and never render it as a non-blocking note.
- Context accuracy: be precise about what is and isn't covered. If related logic is already tested in a sibling file present in the diff, acknowledge it and flag only the specific untested surface — do not claim "no tests exist" when some do.
- Remediation quality: only propose a fix that is specific to the code under review and that you have reasoned is genuinely valuable. Do not emit a generic remediation (e.g. "add tests", "mock the API") without naming the concrete behavior that must be covered and why. If you cannot identify a valuable, concrete fix, describe the gap and its risk instead of prescribing a hollow one.

${PR_STRUCTURE_RULE}

${ENGINEERING_RULES}

### Configuration
- Hardcoded URLs, ports, file paths, email addresses, or domain-specific thresholds
- Magic numbers without named constants
- Environment-specific values not in env vars or config

### Data integrity
- Missing input validation at system boundaries (API endpoints, file reads, env vars)
- No timeout on fetch/HTTP calls (potential cascading failure)
- N+1 query patterns (loop with individual DB calls instead of batch)

## Additional checks
- Missing tests for new functionality
- Logging gaps (missing error context, no debug logs for complex flows)
- Dead code (unused imports, unreachable branches, commented-out code)

## Output format

${REVIEW_OUTPUT_SCHEMA}

Severity calibration — pick the band that matches the ACTUAL impact of the changed lines:
- critical: an exploitable security vulnerability, data loss/corruption, or a guaranteed crash / broken build on the primary path
- high: a likely-exploitable security issue; a correctness bug that yields wrong output; an unhandled failure on a common path; OR a coverage gap (see the coverage carve-out above)
- medium: a correctness issue on an edge case, a resource leak, missing error handling on a non-critical path, a performance concern
- low: style, naming, minor maintainability, docs
Do not inflate severity to force attention, and do not deflate a real security, correctness, or coverage issue. Pick the band that matches actual impact.

Severity guide:
- critical: credential exposure, SQL injection, auth bypass, data loss risk
- high: empty catch blocks (\`catch {}\`, \`.catch(() => {})\`, \`except: pass\`),
        errors swallowed without any logging at any level, missing input validation
        at system boundaries, no timeouts on network calls, hardcoded secrets/URLs,
        client-trusted auth context, PR body missing or vague required sections
        (## Summary, ## Changes, ## Test Plan, ## Operator Deploy Steps when
        prod-touching, ## Expected Outcomes when non-trivial)
- medium: missing tests for new code paths, magic numbers without named constants,
          missing error context (catch logs without the error object), N+1 query
          patterns. Do NOT down-rank an empty catch to medium just because it is
          "small" — silent error swallowing is always high.
- low: style issues, minor documentation gaps
- needs-verification: finding looks suspicious but evidence is inconclusive — reviewer should verify

If the code looks clean, return an empty array: []

Respond with ONLY the JSON array, no markdown fencing, no explanation.`;

// ── Prompt builder ───────────────────────────────────────────────────────────

export function buildReviewPrompt(yamlPath?: string): string {
	const patterns = loadReviewPatterns(yamlPath);
	if (!patterns) return FALLBACK_PROMPT;

	const lines: string[] = [];
	lines.push(
		"You are a senior code reviewer. You will receive the full source files for context followed by the git diff to review. Use the full file context to understand the broader codebase patterns, existing error handling, and architecture before flagging issues in the diff.",
	);

	// Review rules (non-negotiable)
	const reviewRules = patterns["review-rules"];
	if (reviewRules?.length) {
		lines.push("");
		lines.push("## Review rules (non-negotiable)");
		for (const rule of reviewRules) {
			lines.push(`- ${rule}`);
		}
	}

	// Review process
	const reviewProcess = patterns["review-process"];
	if (reviewProcess?.length) {
		lines.push("");
		lines.push("## Review process");
		for (const step of reviewProcess) {
			lines.push(`- ${step}`);
		}
	}

	lines.push("");
	lines.push("## Critical patterns (always flag as critical or high)");

	for (const [catKey, cat] of Object.entries(patterns.categories)) {
		const title = CATEGORY_TITLES[catKey] || catKey;
		lines.push("");
		lines.push(`### ${title}`);
		for (const p of cat.patterns) {
			lines.push(`- ${p.description}`);
		}
	}

	// PR structure rule — applies to all repos, injected here so it survives even
	// when categories come from a per-repo YAML override.
	lines.push("");
	lines.push(PR_STRUCTURE_RULE);

	// Mandatory engineering rules — high-frequency review-finding categories that
	// must gate merges. Injected next to PR_STRUCTURE_RULE so they survive even
	// when categories come from a per-repo YAML override.
	lines.push("");
	lines.push(ENGINEERING_RULES);

	const additionalChecks = patterns["additional-checks"];
	if (additionalChecks?.length) {
		lines.push("");
		lines.push("## Additional checks");
		for (const c of additionalChecks) {
			lines.push(`- ${c.description}`);
		}
	}

	lines.push("");
	lines.push("## Output format");
	lines.push("");
	lines.push(REVIEW_OUTPUT_SCHEMA);

	const severityGuide = patterns["severity-guide"];
	if (severityGuide) {
		lines.push("");
		lines.push("Severity guide:");
		for (const [level, desc] of Object.entries(severityGuide)) {
			lines.push(`- ${level}: ${desc}`);
		}
	}

	lines.push("");
	lines.push("If the code looks clean, return an empty array: []");
	lines.push("");
	lines.push(
		"Respond with ONLY the JSON array, no markdown fencing, no explanation.",
	);

	return lines.join("\n");
}
