/**
 * Shared review prompt builder.
 *
 * Single source of truth for diff review prompts used by:
 * - pre-push session review (Groq)
 * - CI code review (DeepInfra, GLM-5.2)
 * - session-end structured review (Haiku)
 *
 * All prompts are built from templates/review-patterns.yaml.
 * Field names use snake_case to match the review_findings DB table.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  file: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'needs-verification'
  category: string
  description: string
  suggested_fix: string
  line_range: string
  // P1a precision fields (optional, backward compatible). A finding without them
  // stays valid; the shadow verdict uses them to decide whether a non-critical,
  // non-security block is evidence-backed.
  rule_id?: string // the engineering-rule id/slug the finding maps to
  evidence?: string // verbatim diff line(s) the finding is about
  failure_scenario?: string // concrete input/state → wrong outcome
}

export interface ReviewPattern {
  name: string
  severity: string
  description: string
}

export interface ReviewPatterns {
  version: number
  categories: Record<string, { patterns: ReviewPattern[] }>
  'additional-checks': ReviewPattern[]
  'severity-guide': Record<string, string>
  'review-rules'?: string[]
  'review-process'?: string[]
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_YAML_PATH = join(__dirname, '..', '..', 'templates', 'review-patterns.yaml')

const CATEGORY_TITLES: Record<string, string> = {
  security: 'Security',
  'error-handling': 'Error handling',
  configuration: 'Configuration',
  'data-integrity': 'Data integrity',
}

/**
 * Required sections in a PR body, per docs/glossary.md "PR" recipe step 10.
 * Used by the PR-structure check to flag missing or vague sections.
 */
export const PR_BODY_REQUIRED_SECTIONS = ['## Summary', '## Changes', '## Test Plan'] as const

export const PR_BODY_CONDITIONAL_SECTIONS = [
  '## Operator Deploy Steps', // required if PR touches production
  '## Expected Outcomes', // required on non-trivial PRs
] as const

/**
 * Reusable PR-structure rule, injected into both buildReviewPrompt() and FALLBACK_PROMPT
 * so the prompt content is identical regardless of YAML availability.
 *
 * NOTE: the ALWAYS-required sections (## Summary, ## Changes, ## Test Plan) are
 * checked DETERMINISTICALLY in code (see checkPrBodySections in ci-review.ts) —
 * "does the body contain this heading" is not a judgement call. Asking the model
 * to also judge it produced a false CHANGES_REQUESTED on darena #589 (it claimed
 * `## Changes` was missing from a body that plainly contained it). Those checks
 * are therefore removed from this prompt. What REMAINS here is genuine judgement:
 * whether a diff "touches production" (→ Operator Deploy Steps) or is "non-trivial"
 * (→ Expected Outcomes), and whether present sections are vague/unverifiable.
 */
export const PR_STRUCTURE_RULE = `### PR structure
When the user message contains a \`## PR Body\` block, evaluate the PR body against the structure required by \`docs/glossary.md\` "PR" recipe step 10. The presence of the always-required sections (\`## Summary\`, \`## Changes\`, \`## Test Plan\`) is verified deterministically in code — do NOT emit a finding about those sections being missing. Judge only the CONDITIONAL sections and the quality of sections that are present:
- \`## Operator Deploy Steps\` — required if the diff touches production code (fleet scripts, services, scheduled jobs, infra, schemas, CI workflows). Flag HIGH if it is required by the diff but missing.
- \`## Expected Outcomes\` — required on non-trivial PRs (anything bigger than a typo). Flag HIGH if it is required but missing.

Also flag as HIGH severity:
- \`## Operator Deploy Steps\` items that are vague (e.g. "deploy somehow", "rsync to fleet" with no command, "restart the service" with no service name)
- \`## Expected Outcomes\` items without verifiable acceptance criteria (e.g. "verify it works", "should be fine", no \`- [ ]\` checklist)
- \`## Test Plan\` post-merge items (\`- [ ]\`) that are not runnable commands

The finding's \`file\` field for these checks is the literal string \`PR_BODY\` (not a source file path), and \`line_range\` is the section name (e.g. "## Operator Deploy Steps").`

/**
 * Mandatory engineering rules, injected alongside PR_STRUCTURE_RULE into both
 * buildReviewPrompt() and FALLBACK_PROMPT. Encodes the team's most frequently
 * repeated review-finding categories. Severity follows the impact rubric
 * (review-gate-v2 P1b): a rule's "HIGH when" is its usual impact, not a floor,
 * because labelling every violation HIGH made 82% of findings blocking.
 */
export const ENGINEERING_RULES = `### Engineering rules (mandatory — severity by impact)

Evaluate the diff against the rules below. For ANY real violation visible in the diff, emit a finding citing the exact file and line. Set its severity by IMPACT, not by the rule's label:
- critical: data loss, a security breach, or an outage of a shared service.
- high: wrong behaviour on a path that a real input or state reaches. State that input or state in "failure_scenario".
- medium: a latent defect — it needs an unusual state, or no reachable caller in the diff.
- low: hygiene — style, naming, documentation.
A rule's "HIGH when" names its usual impact. Downgrade when your failure_scenario is not reachable. Do not downgrade a security, data-loss, or silent-error-handling (rule 2) finding. A high or critical finding triggers REQUEST_CHANGES and blocks the merge until fixed, so it needs a concrete, reachable failure_scenario. These encode the team's most frequently-repeated review findings. IMPORTANT: only flag what the changed lines actually show; do not invent violations or flag a rule that does not apply to this diff.

1. Unverified assumptions. HIGH when: code, comments, log lines, or messages assert a fact or number with no basis (e.g. throughput like "235 records/hour", "this is correct", "the migration is broken") as if verified; or a calculation uses unverified inputs but is stated as a precise result instead of an estimate.

2. Silent error handling. HIGH when: an empty or log-less catch — \`catch {}\`, \`catch (e) {}\` with no body, \`.catch(() => {})\`, Python \`except ...: pass\` or bare \`except:\` — swallows an error without at least a debug log that includes the error.

3. Missing timeouts on I/O. HIGH when: \`fetch\`, \`net.connect\`, \`axios\`, Python \`requests\`, an upstream/proxy call, or a potentially-slow DB query is issued with no timeout/abort. Also flag direct access to external/parsed data (dict keys, indices) that can throw with no guard.

4. Hardcoded environment-specific values. HIGH when: a hardcoded user-specific path (\`/home/<name>/...\`), IP address, port, channel/ID, or secret/token appears in source; or a magic number is used in non-trivial logic instead of a named constant.

5. Security. HIGH when: TLS/host verification is disabled (\`NODE_TLS_REJECT_UNAUTHORIZED = '0'\`, \`verify=False\`, \`StrictHostKeyChecking=accept-new\`); SQL is built by string concatenation / f-string instead of a parameterized query; a new HTTP route/handler has no auth check; or credentials are read from an insecure location.

6. Missing tests. HIGH when: a new script, module, or worker — or substantial new logic with a reachable failure path — is added with no test of its behaviour in the same diff. Prefer an end-to-end test that runs the real entry point (script, CLI, hook, endpoint) over per-function unit tests: MEDIUM when the only new tests are unit tests of internals and the behaviour itself is never exercised.

7. Production-path changes without a verification story. HIGH when: the diff touches deploy scripts, systemd units, CI workflows, DB schemas/migrations, scheduled jobs, or multi-tenant infra AND the \`## PR Body\` lacks concrete \`## Operator Deploy Steps\` and \`## Expected Outcomes\` containing at least one runnable post-deploy smoke/health command.

8. Dead, duplicated, or truncated code. HIGH when: a logic block is duplicated verbatim (DRY violation); a file ends mid-statement or mid-comment (truncated edit); or code is plainly unreachable.

9. Bash set -e safety. HIGH when: in a script using \`set -e\` / \`set -euo pipefail\`, an optional command (a \`grep\` that may match nothing, an optional tool) runs as a standalone statement without \`|| true\` or an \`if\` guard; or a guard list (\`a && b\`) is the LAST command of a function or script, so its non-zero status propagates to the caller. Do NOT flag a command in an \`if\`/\`elif\`/\`while\`/\`until\` condition or a non-final element of an \`&&\`/\`||\` list: \`set -e\` ignores failures there. Lefthook \`run:\` blocks do NOT enable \`set -e\` unless the block itself sets it (observed with lefthook 2.1.12: a multi-line \`run:\` block reports empty shell flags \`$-\` and keeps running after \`false\`); never assume \`set -e\` is implied.

10. Heavy query on a shared service pool. HIGH (CRITICAL if it can invalidate a shared connection/engine for other callers): the diff adds a \`COUNT(DISTINCT ...)\`, a full-table scan, a large window/dedup, or any unbounded aggregation to a SHARED, memory-constrained request path (an HTTP API handler, a shared DB/DuckDB connection pool). A query that fits when run alone can OOM under concurrency and break the service for everyone. Prefer isolating it in its own process with its own memory_limit, or precomputing into a small materialized table.

11. COUNT(DISTINCT) over large data in a hot path. HIGH: a \`COUNT(DISTINCT key)\` (or several with FILTERs) over a large or append-only history table inside an API/report/request path — it builds a hash set sized to the cardinality and cannot exploit row ordering. Materialize current-state (one row per key) and use \`COUNT(*) FILTER (...)\` instead.

12. Scheduled job not verified in its real execution context. HIGH: the diff adds or changes a scheduled job (a cron entry, a systemd \`.timer\`/\`.service\`, a scheduled script/worker) and the \`## PR Body\` shows no evidence it was verified in the ACTUAL execution context (the cron/systemd environment, the real \`User=\`) rather than only an interactive shell. Interactive-only verification misses env/SSH-agent/sudo/PATH/tty differences that break the scheduled run.

13. A scheduled job or report that does not fail loud. HIGH: a report or scheduled job that, on a backend error or an empty/zero result, still emits output (renders a zeros/empty table, posts a message, writes a record) instead of exiting non-zero and emitting nothing. An HTTP \`200\` or \`rc=0\` is not proof of data — validate the rows/payload before acting; emitting garbage on failure is worse than skipping the run.

14. Merge-automation that ignores strict branch protection. HIGH: the diff adds or changes auto-merge / merge-automation CI (e.g. a workflow arming \`gh pr merge --auto\`) without accounting for \`strict\` ("require branch up to date") protection — under which a PR falls BEHIND when main moves and auto-merge will NOT fire until the branch is updated (needs an update-branch step or a merge queue).

15. English-only string sets in a multilingual codebase. CRITICAL when: a whitelist, category list, keyword filter, allowlist, or any hardcoded string set used to match/gate/route data is English-only while the code processes multilingual data (e.g. a fleet whose sources return Portuguese/Spanish). An English-only match silently drops non-English records — this is data loss, not a missed feature — so verify locale coverage of every hardcoded string set.

16. Unbounded logs. HIGH when: a new or modified app, service, script, cron job, or container writes a log with no size bound or rotation — no logrotate stanza (\`copytruncate\` for a writer that holds the fd open, \`create\` for one that reopens per run), no docker \`log-opts\` \`max-size\`/\`max-file\`, no journald \`SystemMaxUse\`, or a home-grown rotation that a short-lived / cron process never fires. Every log must have a size cap and retention.

17. Missing structured production logging (valors-observability). CRITICAL when: new or modified production code (a service, worker, request handler, pipeline stage, scheduled job) emits logs through a raw logger — \`console.log\` / \`console.info\` / \`console.warn\` / \`console.error\` / \`console.debug\` (TypeScript) or \`print(...)\` (Python) — instead of the mandatory Valors logger (\`import { getLogger } from '@valors/logging'\` then \`getLogger(service, module)\` in TypeScript; \`from valors_logging import get_logger\` then \`get_logger(service, module)\` in Python); or a new or modified Python process entrypoint (an \`if __name__ == "__main__":\` block or the \`main()\` it calls) does not call \`valors_logging.init_logging(service)\` once, or keeps a non-valors handler alongside it (\`logging.basicConfig(filename=...)\`, its own \`FileHandler\`/\`StreamHandler\`) — CRITICAL only when the repo's \`valors_logging\` exports \`init_logging\`, otherwise SUGGESTION (the fix must be importable); or any Python module sets \`propagate = False\` or attaches its own handlers to a stdlib logger (bypasses the root bridge); or a new production service/worker adds non-trivial logic with NO logging at all. Compliant in Python: \`get_logger(...)\`; \`get_stdlib_logger(service, module)\` (a stdlib Logger that emits valors JSON); and \`logging.getLogger(__name__)\` with \`log.<level>(...)\` (or root-logger calls such as \`logging.warning(...)\`) in library/worker modules, because their records reach valors through the root-logger bridge that the entrypoint's \`init_logging(service)\` installs — do NOT flag stdlib \`logging.getLogger(__name__)\` call sites on their own. Raw console/print output bypasses the JSON log schema that Vector ships to the observability pipeline, so production failures become invisible — this is a prod-observability gap, not a style nit. Prefer importing the valors logger and emitting structured events. Exempt: one-shot CLI/CI scripts (files under \`scripts/\` invoked via \`bun scripts/*.ts\` or a GitHub Actions \`run:\` step) whose stdout IS the log — these should use \`console.*\` because \`@valors/logging\` is not a dependency in that context and structured JSON reduces readability for human log consumers; flag only if \`@valors/logging\` is already imported in the same file. Python files under \`scripts/\` run by hand or once in CI are likewise exempt; Python scripts started by a systemd unit or timer are production entrypoints. Also exempt: the Companion app (files under \`companion/web/**\`), which has its OWN stacksniper-based structured logger — \`import { createLogger } from './logger.js'\` then \`createLogger(module)\`, emitting DuckDB-ready JSONL to \`~/.wilco/logs/\`. Treat \`createLogger(...)\` and \`log.debug|info|warn|error(...)\` in companion code as compliant structured logging; do NOT require \`@valors/logging\` there. Raw \`console.*\` / \`print\` in companion production code is STILL a finding.

18. Response body decoded before a status check. HIGH when: code parses a response body (\`.json()\`, \`.text\`, decode) without first checking the status (\`res.ok\`, \`status < 400\`, \`raise_for_status()\`), so a 4xx/5xx error envelope is consumed as valid data; or treats an HTTP 2xx / exit-0 as proof of data without validating the payload/rows.

19. Silent schema-field drop on (de)serialize or upsert. HIGH when: an object or row is rebuilt from a hardcoded/explicit field list (a constructor, a manual \`_row_to_dict\`, a parse against a partial schema) such that any field/column not in the list is silently set to NULL or dropped — especially DB columns not declared in the ORM model, or a backend field missing from a shared JSON schema.

20. Fallback branch that silently mishandles a new variant. HIGH when: an \`if/elif/else\` or \`switch\` catch-all serializes, stringifies, or truncates an unknown case (e.g. \`str(obj)[:80]\`, a default render) instead of handling or failing it — so a newly-added type renders raw or loses data; or it collapses distinct states (a thrown error vs a resolved null) into one value.

21. Silent collection truncation. HIGH when: code takes \`[0]\` or slices a single element from data that can hold multiple (multi-range values, split shifts, \`zip(strict=...)\`) and discards the rest with no length guard.

22. Naive datetime serialized without a timezone. HIGH when: a naive datetime (\`datetime.now()\`, a DB \`TIMESTAMP\`/\`CURRENT_TIMESTAMP\`) is \`.isoformat()\`-serialized for an API/JSON boundary producing a string with no \`Z\`/offset, or an incoming ISO string is parsed without normalizing a missing tz to UTC.

23. Incomplete locale coverage for a new string. HIGH when: a user-facing string or i18n key is added to one locale catalog (e.g. \`en\`) but not the others in the set (\`es_mx\`, \`pt_br\`), or a hardcoded English literal is emitted in user-visible output while an i18n layer exists. Distinct from rule 15 (English-only match/gate string sets causing data loss); this is translation-coverage completeness.

24. Shell command injection via an interpolated subprocess. CRITICAL when: a shell command is built by interpolating a variable into \`execSync\`/\`exec\`/\`spawn({shell:true})\`/\`os.system\`/\`subprocess.run(..., shell=True)\` where the value can be externally sourced (PR/diff content, a file path, user input). Require array-argv form (\`execFileSync(cmd, [args])\`, \`subprocess.run([...])\`). This is the shell-injection sibling of rule 5's SQL-injection clause.

25. Empty-string default feeding URL/path/query construction. HIGH when: a parameter used to build a URL, path segment, or query has an empty-string default (\`id: str = ""\`) that yields a malformed target (\`/versions//publish\`, \`?id=\`) instead of \`None\` plus an explicit early guard that returns a clear error.

26. Stale tests or fixtures for an intentional behavior change. HIGH when: the diff changes an output format, contract, enum, field set, or role/ARIA semantics but does not update the assertion sites, fixtures, or protocol examples in the same diff — leaving stale assertions that break CI or, worse, pass while asserting the old (now wrong) behavior. Distinct from rule 6 (missing tests for NEW code).

27. Generated or derived artifact not regenerated after a schema change. HIGH when: the diff edits a source-of-truth schema (\`*.schema.json\`, a Pydantic discriminated union, an OpenAPI/JSON-Schema file) without regenerating the derived types/fixtures/examples in the same diff, or hand-edits a generated file without touching its generator/schema.

28. Uncited capability claim. HIGH when: a comment, docstring, rule/doc file, or PR body asserts that a capability does NOT exist, is unsupported, or is impossible on some path — e.g. "X has no effort concept", "the SDK does not support Y", "this can only be done via Z", "the review clamps the diff at N chars" — without citing what it was checked against (a \`file:line\` in a type definition or implementation, or a doc URL). A NEGATIVE capability claim is the dangerous direction: it reads as a settled design decision rather than an assertion, so reviewers and future authors accept it without re-checking. A wrong one silently deletes a feature, justifies a needless workaround, or ossifies a limitation that no longer exists. Also flag a claim whose only cited source is a follow-up issue, another comment, or a prior PR description rather than the authority itself. Fix: cite the authority inline, or soften the claim to what was actually observed — "we do not currently wire X" instead of "X does not exist".

29. Documentation that explains how, not why. LOW (advisory): flag a comment, docstring, or doc only when a non-obvious decision or constraint has no stated reason, or when it restates what the code plainly does. Do NOT flag missing docstrings.

30. Prose where a diagram belongs. LOW (advisory): a design doc or PR body that describes a flow of 3 or more linked parts (pipeline, state machine, call chain) in prose. Suggest a Mermaid diagram.`

/**
 * Standardized output schema description for all diff review prompts.
 * Uses snake_case to match review_findings DB columns.
 */
export const REVIEW_OUTPUT_SCHEMA = `Output ONLY a JSON object with a "findings" array. Each finding must have:
- "file": the filename from the diff
- "severity": "critical" | "high" | "medium" | "low" | "needs-verification"
- "category": short category name (e.g. "security", "error-handling", "testing", "logging", "hardcoded-value", "dead-code", "config", "data-integrity")
- "description": concise description of the issue
- "suggested_fix": brief suggestion for how to fix it
- "line_range": approximate line range from the diff (e.g. "+42-+55")
- "rule_id": the engineering-rule number or a short slug this maps to (e.g. "rule-9"), when applicable
- "evidence": the verbatim changed line(s) from the diff this finding is about, copied exactly (added or removed lines)
- "failure_scenario": one concrete input/state that leads to the wrong outcome`

// ── YAML loader ──────────────────────────────────────────────────────────────

export function loadReviewPatterns(yamlPath?: string): ReviewPatterns | null {
  const path = yamlPath || DEFAULT_YAML_PATH
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return YAML.parse(raw) as ReviewPatterns
  } catch (err) {
    console.warn(`[review-prompt] Failed to load review patterns from ${path}:`, err)
    return null
  }
}

// ── Fallback prompt ──────────────────────────────────────────────────────────

export const FALLBACK_PROMPT = `You are a senior code reviewer. You will receive the full source files for context followed by the git diff to review. Use the full file context to understand the broader codebase patterns, existing error handling, and architecture before flagging issues in the diff.

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
- Hardcoded credentials, API keys, passwords, or connection strings with auth info
- SQL/command injection: string concatenation in queries instead of parameterized
- Client-supplied userId/auth context trusted without server-side derivation
- Missing auth checks on endpoints
- Secrets logged or exposed in error messages

### Error handling
- Empty catch blocks: \`catch {}\`, \`catch { /* comment */ }\`, \`.catch(() => {})\`
- \`except Exception: pass\` or \`except: pass\` in Python
- Errors swallowed without any logging (at minimum console.debug)
- Missing error context: catch logs a generic message without the error object

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

Severity guide (by impact — see the engineering-rules rubric):
- critical: data loss, security breach (credential exposure, SQL injection, auth bypass), shared-service outage
- high: wrong behaviour on a reachable path, e.g. empty catch blocks (\`catch {}\`, \`.catch(() => {})\`, \`except: pass\`),
        errors swallowed without any logging at any level, missing input validation
        at system boundaries, no timeouts on network calls, hardcoded secrets/URLs,
        client-trusted auth context, PR body missing a conditionally-required
        section (## Operator Deploy Steps when prod-touching, ## Expected Outcomes
        when non-trivial) or with vague/unverifiable items (the always-required
        ## Summary / ## Changes / ## Test Plan presence is checked in code, not here)
- medium: missing tests for new code paths, magic numbers without named constants,
          missing error context (catch logs without the error object), N+1 query
          patterns. Do NOT down-rank an empty catch to medium just because it is
          "small" — silent error swallowing is always high.
- low: hygiene — style issues, naming, documentation that lacks a why
- needs-verification: finding looks suspicious but evidence is inconclusive — reviewer should verify

If the code looks clean, return: {"findings": []}

Respond with ONLY {"findings": [...]}, no markdown fencing, no explanation.`

// ── Writing standard ─────────────────────────────────────────────────────────

// rules/ in a wilco checkout; scripts/lib/ in the rc-international/ci copy,
// whose reusable workflow sparse-checks-out only scripts/ci-review.ts + scripts/lib/.
export const WRITING_STANDARD_PATHS = [
  join(__dirname, '..', '..', 'rules', 'terse-briefings.md'),
  join(__dirname, 'terse-briefings.md'),
]

/**
 * Return the `- ` bullets of the `## Language` section, or null if absent.
 * Only the bullets: the section's Scope/Measurement paragraphs describe the
 * ste-coach hook, not how to write, and would cost input tokens per chunk.
 */
export function extractLanguageRules(markdown: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^## Language\b/.test(l))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  const bullets = (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- '))
  return bullets.length ? bullets.join('\n') : null
}

/**
 * Load the writing standard for finding text from rules/terse-briefings.md.
 * Read at runtime so the gate and the rule cannot drift
 * (docs/design/review-gate-v2.md). Missing file → null; the review still runs.
 */
export function loadWritingStandard(paths: string[] = WRITING_STANDARD_PATHS): string | null {
  const path = paths.find((p) => existsSync(p))
  if (!path) {
    console.warn(
      `[review-prompt] Writing standard not found at ${paths.join(' or ')}; finding text is not STE-constrained.`
    )
    return null
  }
  try {
    const rules = extractLanguageRules(readFileSync(path, 'utf-8'))
    if (!rules) {
      console.warn(
        `[review-prompt] No "## Language" bullets in ${path}; finding text is not STE-constrained.`
      )
      return null
    }
    return `## Writing standard for finding text

Write "description", "failure_scenario" and "suggested_fix" in ASD-STE100, loosely applied:
${rules}`
  } catch (err) {
    console.warn(`[review-prompt] Failed to load writing standard from ${path}:`, err)
    return null
  }
}

// ── Prompt builder ───────────────────────────────────────────────────────────

export function buildReviewPrompt(yamlPath?: string, writingStandardPaths?: string[]): string {
  const writingStandard = loadWritingStandard(writingStandardPaths)
  const patterns = loadReviewPatterns(yamlPath)
  if (!patterns) {
    // Same placement as the YAML path: before the output format, so the JSON-only
    // directive stays the last instruction.
    return writingStandard
      ? FALLBACK_PROMPT.replace('\n## Output format', `\n${writingStandard}\n\n## Output format`)
      : FALLBACK_PROMPT
  }

  const lines: string[] = []
  lines.push(
    'You are a senior code reviewer. You will receive the full source files for context followed by the git diff to review. Use the full file context to understand the broader codebase patterns, existing error handling, and architecture before flagging issues in the diff.'
  )

  // Review rules (non-negotiable)
  const reviewRules = patterns['review-rules']
  if (reviewRules?.length) {
    lines.push('')
    lines.push('## Review rules (non-negotiable)')
    for (const rule of reviewRules) {
      lines.push(`- ${rule}`)
    }
  }

  // Review process
  const reviewProcess = patterns['review-process']
  if (reviewProcess?.length) {
    lines.push('')
    lines.push('## Review process')
    for (const step of reviewProcess) {
      lines.push(`- ${step}`)
    }
  }

  lines.push('')
  lines.push('## Critical patterns (always flag as critical or high)')

  for (const [catKey, cat] of Object.entries(patterns.categories)) {
    const title = CATEGORY_TITLES[catKey] || catKey
    lines.push('')
    lines.push(`### ${title}`)
    for (const p of cat.patterns) {
      lines.push(`- ${p.description}`)
    }
  }

  // PR structure rule — applies to all repos, injected here so it survives even
  // when categories come from a per-repo YAML override.
  lines.push('')
  lines.push(PR_STRUCTURE_RULE)

  // Mandatory engineering rules — high-frequency review-finding categories that
  // must gate merges. Injected next to PR_STRUCTURE_RULE so they survive even
  // when categories come from a per-repo YAML override.
  lines.push('')
  lines.push(ENGINEERING_RULES)

  const additionalChecks = patterns['additional-checks']
  if (additionalChecks?.length) {
    lines.push('')
    lines.push('## Additional checks')
    for (const c of additionalChecks) {
      lines.push(`- ${c.description}`)
    }
  }

  if (writingStandard) {
    lines.push('')
    lines.push(writingStandard)
  }

  lines.push('')
  lines.push('## Output format')
  lines.push('')
  lines.push(REVIEW_OUTPUT_SCHEMA)

  const severityGuide = patterns['severity-guide']
  if (severityGuide) {
    lines.push('')
    lines.push('Severity guide:')
    for (const [level, desc] of Object.entries(severityGuide)) {
      lines.push(`- ${level}: ${desc}`)
    }
  }

  lines.push('')
  lines.push('If the code looks clean, return: {"findings": []}')
  lines.push('')
  lines.push('Respond with ONLY {"findings": [...]}, no markdown fencing, no explanation.')

  return lines.join('\n')
}
