#!/usr/bin/env bun
/**
 * CI Code Review
 *
 * GitHub Actions workflow script: reads PR diff, calls the review model for
 * review, posts findings as a PR review comment. Safety net for code that
 * bypasses the wilco pre-push review pipeline.
 *
 * Usage:
 *   gh pr diff $PR_NUMBER | bun scripts/ci-review.ts
 *   bun scripts/ci-review.ts path/to/diff.txt
 *
 * Environment:
 *   CI_REVIEW_DEEPINFRA_API_KEY    — DeepInfra API key (required in CI; DEEPINFRA_API_KEY also accepted)
 *   GITHUB_REPOSITORY              — owner/repo (set by GitHub Actions)
 *   PR_NUMBER                      — pull request number
 *   CI_REVIEW_MODEL                — model override (default: zai-org/GLM-5.2)
 *   CI_REVIEW_FALLBACK_MODEL       — tried when the primary is overloaded/failing
 *                                    (default: deepseek-ai/DeepSeek-V4-Pro; '' disables)
 *   CI_REVIEW_ENDPOINT             — endpoint override (default: DeepInfra chat/completions)
 *   CI_REVIEW_BOT_LOGIN            — login of the reviewing bot, to find its prior reviews
 *                                    (default: valors-release-bot; a `[bot]` suffix is ignored)
 *   CI_REVIEW_REASONING_EFFORT     — GLM reasoning effort (default: none — GLM-5.2 "thinking" adds ~5min; none returns in ~11s)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { Nodes, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toString as mdastToString } from 'mdast-util-to-string'
import {
  applyPostModelFilters,
  buildRebuttalContext,
  computeCacheKey,
  encodeCacheMarker,
  type PrCommentRecord,
  type PrReviewRecord,
  parseChangedLines,
  reviewWithCache,
  sanitizeFindingForBody,
} from './lib/ci-review-determinism.js'
import { type CommitAuthor, checkCommitAuthors } from './lib/commit-author-guard.js'
import { computeImpactScore, formatImpactScore, type ImpactScore } from './lib/impact-score.js'
import {
  buildReviewPrompt,
  PR_BODY_REQUIRED_SECTIONS,
  type ReviewFinding,
} from './lib/review-prompt.js'
import { streamChatCompletion } from './lib/stream-chat.js'

// ── Configuration ────────────────────────────────────────────────────────────

const REVIEW_ENDPOINT =
  process.env.CI_REVIEW_ENDPOINT || 'https://api.deepinfra.com/v1/openai/chat/completions'
const REVIEW_MODEL = process.env.CI_REVIEW_MODEL || 'zai-org/GLM-5.2'
const CI_REVIEW_REASONING = process.env.CI_REVIEW_REASONING_EFFORT || 'none'
// Streamed reasoning on a big all-files prompt can exceed 5 min; because the
// connection stays alive under `stream: true` (GLM-5.2 emits reasoning_content
// deltas as keep-alives) a longer bound is safe — and necessary, since the
// non-streamed 4.5-min DeepInfra socket-drop is what this streaming path fixes.
const CI_TIMEOUT_MS = 600_000
const MAX_CONTEXT_CHARS = 400_000 // ~100K tokens, well within 131K context limit
const MAX_DIFF_SIZE = MAX_CONTEXT_CHARS // kept as alias for parseDiff compat
const BUDGET_PER_FILE = 50_000 // cap individual file content in context
const MIN_DIFF_BUDGET_CHARS = 100_000 // always reserve room for the diff, even with many files
const RETRY_DELAY_MS = 2_000
const MAX_RETRIES = 1
// Provider overload (429/503, engine_overloaded) gets a 5.5-min backoff. Observed
// 2026-10-03, PR #798: DeepInfra returned 429 engine_overloaded within ~3s on
// both tries (runs 15:15 and 16:12 UTC), so the review was skipped and needed a
// human approval. Recovery time is not measured; the schedule is an estimate:
// roughly tripling gaps within a 5.5-min total, so a stuck provider costs one
// bounded wait. No jitter: one job retries sequentially, nothing to de-sync. A
// timeout already cost up to CI_TIMEOUT_MS, so it keeps the single short retry.
const OVERLOAD_BACKOFF_MS = [15_000, 45_000, 90_000, 180_000]
// Second DeepInfra model, same API key. The full 5.5-min backoff did not save
// PR #802 (run 37139427368: 429 engine_overloaded on all 5 attempts); each such
// run posts the skip notice and needs a manual `approved`.
// A different vendor's model is unlikely to be overloaded at the same moment.
// Probed 2026-10-04: DeepSeek-V4-Pro accepts response_format=json_object and
// reasoning_effort=none, 1M context. Set CI_REVIEW_FALLBACK_MODEL='' to disable.
const FALLBACK_MODEL = process.env.CI_REVIEW_FALLBACK_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro'
// Overload retries on a model that has a fallback behind it. One short wait,
// then switch: waiting longer on an overloaded primary is what failed on #802.
const OVERLOAD_RETRIES_BEFORE_FALLBACK = 1

function isOverload(errMessage: string): boolean {
  return /\b(429|503)\b|engine_overloaded/.test(errMessage)
}

/**
 * Delay before retrying the SAME model (retry is 1-based), or null to stop
 * using that model (move to the fallback if there is one, else give up).
 */
export function retryDelayMs(
  retry: number,
  errMessage: string,
  hasFallback = false
): number | null {
  // max_tokens truncation repeats with identical params — do not retry it.
  if (errMessage.includes('finish_reason=length')) return null
  if (isOverload(errMessage)) {
    if (hasFallback && retry > OVERLOAD_RETRIES_BEFORE_FALLBACK) return null
    return OVERLOAD_BACKOFF_MS[retry - 1] ?? null
  }
  return retry <= MAX_RETRIES ? RETRY_DELAY_MS : null
}

/** Models to try in order: primary, then fallback if set and different. */
export function reviewModels(primary: string, fallback: string): string[] {
  return fallback && fallback !== primary ? [primary, fallback] : [primary]
}
// Who authored the PR reviews that carry the verdict-cache marker. GitHub reports
// the App as `valors-release-bot[bot]` (verified via the reviews API 2026-10-09);
// sameLogin() ignores the suffix. Only this author's markers are trusted.
const BOT_LOGIN = process.env.CI_REVIEW_BOT_LOGIN || 'valors-release-bot'
// Deterministic sampling: reruns on the same input must not re-roll findings
// (menu-expert#408 raised a new false HIGH per round at temperature 0.2).
// DeepInfra returned HTTP 200 for temperature 0 + seed 0 on both review models
// (probed 2026-10-09); whether the seed is honoured is not verifiable from the
// response, so the verdict cache — not the seed — is the real guarantee.
const REVIEW_TEMPERATURE = 0
const REVIEW_SEED = 0
const APPROVAL_COMMENT = 'approved'
const TRUSTED_APPROVAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER'])

const DOC_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.asciidoc',
  '.wiki',
  '.tex',
  '.org',
  '.rdoc',
  '.textile',
])

// ── Types ────────────────────────────────────────────────────────────────────
// ReviewFinding imported from shared module

interface ReviewResult {
  findings: ReviewFinding[]
  apiError: boolean
  /** Model that produced the findings (set when apiError is false). */
  model?: string
}

interface DiffInfo {
  cleanDiff: string
  isEmpty: boolean
  isDocsOnly: boolean
  wasTruncated: boolean
  fileCount: number
}

interface ManualApproval {
  author: string
  association: string
}

// Review patterns, prompt building, and FALLBACK_PROMPT imported from shared module

// ── Diff parsing ────────────────────────────────────────────────────────────

function parseDiff(rawDiff: string): DiffInfo {
  if (!rawDiff || !rawDiff.trim()) {
    return { cleanDiff: '', isEmpty: true, isDocsOnly: false, wasTruncated: false, fileCount: 0 }
  }

  // Split into per-file sections
  const fileSections = rawDiff.split(/^(?=diff --git )/m).filter(Boolean)
  const fileCount = fileSections.length

  // Filter out binary files
  const textSections = fileSections.filter(
    (section) => !section.includes('Binary files') && !section.includes('GIT binary patch')
  )

  // Check if docs-only
  const filePathRegex = /^diff --git a\/(.+?) b\//m
  const allPaths = textSections.map((s) => s.match(filePathRegex)?.[1]).filter(Boolean) as string[]

  const isDocsOnly =
    allPaths.length > 0 &&
    allPaths.every((p) => {
      const ext = `.${p.split('.').pop()?.toLowerCase()}`
      return DOC_EXTENSIONS.has(ext)
    })

  let cleanDiff = textSections.join('')
  let wasTruncated = false

  if (cleanDiff.length > MAX_DIFF_SIZE) {
    cleanDiff = cleanDiff.slice(0, MAX_DIFF_SIZE)
    wasTruncated = true
  }

  return {
    cleanDiff,
    isEmpty: cleanDiff.trim().length === 0,
    isDocsOnly,
    wasTruncated,
    fileCount,
  }
}

// ── Full file context ───────────────────────────────────────────────────────

function extractChangedFiles(rawDiff: string): string[] {
  const filePathRegex = /^diff --git a\/(.+?) b\//gm
  const files = new Set<string>()
  let match = filePathRegex.exec(rawDiff)
  while (match !== null) {
    files.add(match[1])
    match = filePathRegex.exec(rawDiff)
  }
  return [...files]
}

function buildFileContext(changedFiles: string[], fullContents?: Map<string, string>): string {
  const sections: string[] = []
  const budgetPerFile = BUDGET_PER_FILE
  // Cap total file context so the diff always keeps at least MIN_DIFF_BUDGET_CHARS.
  const maxContextForFiles = MAX_CONTEXT_CHARS - MIN_DIFF_BUDGET_CHARS
  let accumulated = 0

  for (const filePath of changedFiles) {
    if (DOC_EXTENSIONS.has(`.${filePath.split('.').pop()?.toLowerCase()}`)) continue
    if (accumulated >= maxContextForFiles) break
    try {
      const content = execFileSync('git', ['show', `HEAD:${filePath}`], {
        encoding: 'utf-8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      })
      fullContents?.set(filePath, content)
      const truncated =
        content.length > budgetPerFile
          ? `${content.slice(0, budgetPerFile)}\n... (truncated)`
          : content
      const section = `=== FILE: ${filePath} ===\n${truncated}`
      sections.push(section)
      accumulated += section.length
    } catch (e) {
      console.debug(`[ci-review] Could not read ${filePath} from HEAD, skipping:`, e)
    }
  }

  return sections.join('\n\n')
}

// ── Review model API call ──────────────────────────────────────────────────────

const REVIEW_PROMPT = buildReviewPrompt()

function buildUserMessage(
  diff: string,
  fileContext: string,
  prBody = '',
  rebuttalContext = ''
): string {
  const parts: string[] = []

  if (prBody) {
    parts.push('## PR Body\n\n')
    parts.push(prBody)
    parts.push('\n\n')
  }

  if (fileContext) {
    parts.push('## Full source files (for context)\n')
    parts.push(fileContext)
    parts.push('\n\n')
  }

  parts.push('## Diff to review\n\n')
  // Budget: leave room for system prompt (~3K) + file context + output tokens
  const diffBudget = Math.max(MIN_DIFF_BUDGET_CHARS, MAX_CONTEXT_CHARS - fileContext.length)
  if (diff.length > diffBudget) {
    parts.push(diff.slice(0, diffBudget))
    parts.push('\n\n... (diff truncated)')
  } else {
    parts.push(diff)
  }

  if (rebuttalContext) {
    parts.push('\n\n')
    parts.push(rebuttalContext)
  }

  return parts.join('')
}

// ── Manual approval comments ───────────────────────────────────────────────

function isApprovedComment(body: string | undefined): boolean {
  return (body || '').trim().toLowerCase() === APPROVAL_COMMENT
}

function isTrustedApprovalAssociation(association: string | undefined): boolean {
  return TRUSTED_APPROVAL_ASSOCIATIONS.has((association || '').trim().toUpperCase())
}

function getManualApprovalFromEnv(
  env: Record<string, string | undefined> = process.env
): ManualApproval | null {
  if (env.GITHUB_EVENT_NAME !== 'issue_comment') return null
  if (env.COMMENT_IS_PR !== 'true') return null
  if (!isApprovedComment(env.COMMENT_BODY)) return null
  if (!isTrustedApprovalAssociation(env.COMMENT_AUTHOR_ASSOCIATION)) return null

  return {
    author: env.COMMENT_AUTHOR || 'unknown',
    association: (env.COMMENT_AUTHOR_ASSOCIATION || '').trim().toUpperCase(),
  }
}

interface CallReviewOptions {
  /** Models in try order. Default: primary + fallback (see reviewModels). */
  models?: string[]
  /** Injectable for tests so backoff waits don't run in real time. */
  sleep?: (ms: number) => Promise<void>
  /** "Previously rebutted on this PR" section appended to the user message. */
  rebuttalContext?: string
}

async function callReviewModel(
  apiKey: string,
  diff: string,
  fileContext: string,
  prBody = '',
  opts: CallReviewOptions = {}
): Promise<ReviewResult> {
  const models = opts.models ?? reviewModels(REVIEW_MODEL, FALLBACK_MODEL)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (const [i, model] of models.entries()) {
    const hasFallback = i < models.length - 1
    const result = await callOneModel(
      apiKey,
      model,
      diff,
      fileContext,
      prBody,
      hasFallback,
      sleep,
      opts.rebuttalContext ?? ''
    )
    if (!result.apiError) {
      if (i > 0) console.warn(`[ci-review] Review served by fallback model ${model}.`)
      return result
    }
    if (hasFallback) {
      console.warn(`[ci-review] ${model} unavailable — switching to fallback ${models[i + 1]}.`)
    }
  }
  return { findings: [], apiError: true }
}

async function callOneModel(
  apiKey: string,
  model: string,
  diff: string,
  fileContext: string,
  prBody: string,
  hasFallback: boolean,
  sleep: (ms: number) => Promise<void>,
  rebuttalContext = ''
): Promise<ReviewResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Stream the completion. DeepInfra silently drops the socket after ~4.5min
      // on long non-streaming inference; GLM-5.2's reasoning_content deltas keep
      // the streamed connection alive so a big all-files review completes.
      const raw = await streamChatCompletion({
        endpoint: REVIEW_ENDPOINT,
        apiKey,
        body: {
          model,
          messages: [
            {
              role: 'user',
              content: `${REVIEW_PROMPT}\n\n${buildUserMessage(diff, fileContext, prBody, rebuttalContext)}`,
            },
          ],
          temperature: REVIEW_TEMPERATURE,
          seed: REVIEW_SEED,
          max_tokens: 16384,
          reasoning_effort: CI_REVIEW_REASONING,
          response_format: { type: 'json_object' },
        },
        timeoutMs: CI_TIMEOUT_MS,
      })

      // Strip an accidental ```json fence like the pre-push extractFindings does.
      const content = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')

      const parsed = JSON.parse(content) as { findings?: unknown } | ReviewFinding[]
      const findings = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.findings)
          ? parsed.findings
          : (() => {
              throw new Error('Review response must contain a findings array')
            })()
      return {
        findings: findings.filter(
          (f) =>
            f.file &&
            f.severity &&
            f.category &&
            f.description &&
            ['critical', 'high', 'medium', 'low', 'needs-verification'].includes(f.severity)
        ),
        apiError: false,
        model,
      }
    } catch (err) {
      const e = err as Error
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        console.error(`[ci-review] ${model} review API timed out (${CI_TIMEOUT_MS / 1000}s limit)`)
      } else {
        console.error(`[ci-review] ${model} review API error:`, e?.message || err)
      }
      const delay = retryDelayMs(attempt + 1, String(e?.message ?? err), hasFallback)
      if (delay === null) return { findings: [], apiError: true }
      console.log(`[ci-review] Retrying ${model} in ${delay / 1000}s (attempt ${attempt + 2})...`)
      await sleep(delay)
    }
  }
}

/**
 * Post-model filters over the model's findings. Scope is judged against the RAW
 * diff (all files): the 400KB cleanDiff slice omits files past the cut, which
 * would otherwise make every finding on them look "out of diff".
 */
function filterModelFindings(
  findings: ReviewFinding[],
  rawDiff: string,
  diffInfo: Pick<DiffInfo, 'wasTruncated'>,
  fileContents: Map<string, string>
): ReviewFinding[] {
  return applyPostModelFilters(findings, {
    changedLines: parseChangedLines(rawDiff),
    fileContents,
    truncated: diffInfo.wasTruncated,
    rawDiff,
  }).kept
}

/**
 * Verdict-cache key. Takes the RAW diff (all files), never the size-capped copy
 * the model sees: two PRs that differ only past the 400KB cut are different reviews.
 */
function reviewCacheKey(
  rawDiff: string,
  models: string[],
  fileContext: string,
  prBody: string,
  rebuttalContext = ''
): string {
  return computeCacheKey({
    diff: rawDiff,
    prompt: REVIEW_PROMPT,
    models,
    fileContext,
    reasoning: CI_REVIEW_REASONING,
    prBody,
    rebuttalContext,
  })
}

// ── Review formatting ───────────────────────────────────────────────────────

function reviewEvent(findings: ReviewFinding[]): 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE' {
  const hasCriticalOrHigh = findings.some((f) => f.severity === 'critical' || f.severity === 'high')
  return hasCriticalOrHigh ? 'REQUEST_CHANGES' : 'APPROVE'
}

/**
 * Decide what to post when the LLM review did NOT run (no API key, or the review
 * API errored). Deterministic findings (commit-author guard + PR-body required
 * sections) are established WITHOUT the model, so they must still block: if any
 * exist we REQUEST_CHANGES; otherwise we fall back to the manual-approval
 * COMMENT. This is factored out so the "API down must not silently drop the
 * deterministic PR-body enforcement" contract is unit-testable without invoking
 * `main()` (which calls `gh` and `process.exit`).
 */
function reviewOutcomeWithoutModel(
  deterministicFindings: ReviewFinding[]
): 'REQUEST_CHANGES' | 'COMMENT' {
  return deterministicFindings.length > 0 ? 'REQUEST_CHANGES' : 'COMMENT'
}

interface FormatOptions {
  wasTruncated: boolean
  fileCount: number
  impactScore?: ImpactScore
  /** Set when the fallback model served the review, so readers know. */
  fallbackModel?: string
  /** Hidden verdict-cache marker (see encodeCacheMarker); appended last. */
  cacheMarker?: string | null
}

const GITHUB_BODY_LIMIT = 65_000 // GitHub's hard cap is 65,536; keep headroom.

function formatReviewBody(rawFindings: ReviewFinding[], opts: FormatOptions): string {
  // Model/PR text must never open or close an HTML comment: a quoted cache
  // marker would otherwise be readable as a verdict.
  const findings = rawFindings.map(sanitizeFindingForBody)
  const lines: string[] = []
  const finish = (): string => {
    const body = lines.join('\n')
    if (!opts.cacheMarker) return body
    // GitHub rejects review bodies over 65,536 chars; a too-large marker would
    // fail every post. Skip caching for that run instead (fail-safe).
    if (body.length + opts.cacheMarker.length + 2 > GITHUB_BODY_LIMIT) {
      console.warn(
        '[ci-review] Review body + cache marker exceed the GitHub limit; verdict not cached.'
      )
      return body
    }
    return `${body}\n\n${opts.cacheMarker}`
  }
  lines.push('## Automated Code Review')
  lines.push('')
  lines.push('> This review was generated by the wilco CI code review pipeline.')
  lines.push('')

  if (opts.fallbackModel) {
    lines.push(
      `> **Note:** Primary model ${REVIEW_MODEL} was unavailable; reviewed by fallback ${opts.fallbackModel}.`
    )
    lines.push('')
  }

  if (opts.wasTruncated) {
    lines.push(
      `> **Note:** The PR diff was truncated (${opts.fileCount} files, exceeded ${MAX_DIFF_SIZE / 1000}KB limit). Some files may not have been reviewed.`
    )
    lines.push('')
  }

  if (findings.length === 0) {
    lines.push('Code review passed -- no issues found.')
    if (opts.impactScore) {
      lines.push('')
      lines.push(formatImpactScore(opts.impactScore))
    }
    return finish()
  }

  // Severity counts
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    'needs-verification': 0,
  }
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1
  }

  const nvCount = counts['needs-verification']
  const nvSuffix = nvCount > 0 ? ` | Needs-verification: ${nvCount}` : ''
  lines.push(
    `**Summary:** Critical: ${counts.critical} | High: ${counts.high} | Medium: ${counts.medium} | Low: ${counts.low}${nvSuffix}`
  )
  lines.push('')

  // Group findings by severity
  const severityOrder = ['critical', 'high', 'medium', 'low', 'needs-verification'] as const
  for (const sev of severityOrder) {
    const sevFindings = findings.filter((f) => f.severity === sev)
    if (sevFindings.length === 0) continue

    const icon =
      sev === 'critical'
        ? '!!!'
        : sev === 'high'
          ? '!!'
          : sev === 'medium'
            ? '!'
            : sev === 'needs-verification'
              ? '?'
              : '.'
    lines.push(`### ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${icon})`)
    lines.push('')

    for (const f of sevFindings) {
      lines.push(`- **${f.file}** (${f.line_range || '?'}): ${f.description}`)
      if (f.suggested_fix) {
        lines.push(`  - Fix: ${f.suggested_fix}`)
      }
    }
    lines.push('')
  }

  if (opts.impactScore) {
    lines.push(formatImpactScore(opts.impactScore))
  }

  return finish()
}

// ── Get PR commit messages ──────────────────────────────────────────────────

function getPrCommitMessages(prNumber: string): string[] {
  try {
    const json = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits[].messageHeadline'],
      { encoding: 'utf-8', timeout: 10_000 }
    )
    return json.trim().split('\n').filter(Boolean)
  } catch (err) {
    console.debug(`[ci-review] PR commit messages fetch failed for #${prNumber}:`, err)
    return []
  }
}

// ── Get PR commit authors (for the deterministic placeholder-author guard) ───

interface CommitAuthorsResult {
  /** True when the `gh` fetch succeeded (even if it returned zero commits). */
  ok: boolean
  authors: CommitAuthor[]
  /** Populated only when ok === false — the fetch error message. */
  error?: string
}

function getPrCommitAuthors(prNumber: string): CommitAuthor[] {
  return fetchPrCommitAuthors(prNumber).authors
}

function fetchPrCommitAuthors(prNumber: string): CommitAuthorsResult {
  try {
    // One line per commit: <oid>\t<author-name>\t<author-email>. `gh` exposes the
    // git author on each commit's first `authors[]` entry (name + email), which is
    // what `%an`/`%ae` would give from `git log`.
    const raw = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'commits',
        '--jq',
        '.commits[] | "\\(.oid)\\t\\(.authors[0].name // "")\\t\\(.authors[0].email // "")"',
      ],
      { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 }
    )
    const authors = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', name = '', email = ''] = line.split('\t')
        return { sha, name, email }
      })
    return { ok: true, authors }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[ci-review] PR commit authors fetch failed for #${prNumber}: ${message}`)
    return { ok: false, authors: [], error: message }
  }
}

/**
 * Resolve the deterministic commit-author findings for a PR. On a successful
 * fetch this is exactly `checkCommitAuthors(authors)`. If the fetch FAILS, the
 * guard must NOT fail open (returning `[]` would let a clean-approve slip past),
 * so a `high` finding is emitted noting the guard could not run — enough to keep
 * the review from clean-approving.
 */
function resolveCommitAuthorFindings(prNumber: string): ReviewFinding[] {
  const result = fetchPrCommitAuthors(prNumber)
  if (!result.ok) {
    return [
      {
        file: 'COMMIT_AUTHORS',
        severity: 'high',
        category: 'commit-author',
        description: `The commit-author guard could not run for PR #${prNumber}: fetching commit authors via \`gh\` failed (${result.error ?? 'unknown error'}). Placeholder-author commits cannot be ruled out, so this PR is not clean-approved.`,
        suggested_fix:
          'Re-run the code-review workflow. If it keeps failing, verify the `gh` CLI is authenticated and the PR is accessible, then confirm no commit was authored under a placeholder identity (e.g. Test <test@test.com>).',
        line_range: 'commit-author-guard',
      },
    ]
  }
  return checkCommitAuthors(result.authors)
}

function getPrBody(prNumber: string): string {
  try {
    return execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'body', '--jq', '.body'], {
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 200_000,
    }).trim()
  } catch (err) {
    console.warn(
      `[ci-review] PR body fetch failed for #${prNumber}: ${err instanceof Error ? err.message : err}`
    )
    return ''
  }
}

// ── Deterministic PR-body required-section check ────────────────────────────

/**
 * Deterministically check the PR body for the ALWAYS-required sections
 * (PR_BODY_REQUIRED_SECTIONS: `## Summary`, `## Changes`, `## Test Plan`).
 *
 * "Does this string contain a `## Changes` heading" is not a judgement call, so
 * it must not be left to the LLM reviewer: on darena #589 the model posted a
 * false CHANGES_REQUESTED claiming `## Changes` was missing from a body that
 * plainly contained it. This code answers that question; the prompt no longer
 * asks the model to (see PR_STRUCTURE_RULE). The CONDITIONAL sections
 * (Operator Deploy Steps / Expected Outcomes) stay with the model because
 * whether they are required depends on judging the diff.
 *
 * Implementation: parse the body with a real CommonMark parser
 * (`mdast-util-from-markdown`) and collect the TOP-LEVEL level-2 (`depth === 2`)
 * `heading` nodes — direct children of the AST root, NOT recursing into
 * containers — comparing each heading's plain text (via `mdast-util-to-string`,
 * trimmed) against the section names. Restricting to top-level headings means a
 * heading nested inside a blockquote (`> ## Changes`) or a list item is treated
 * as quoted/embedded content and does NOT satisfy the check. This replaced a
 * hand-rolled regex + fence/HTML-comment stripping pair that diverged from
 * real Markdown once per review round: it accepted 4-space-indented headings,
 * headings inside fences, decorated headings, and headings inside HTML
 * comments, and its FINAL bug was a FALSE NEGATIVE — a ``` marker inside an
 * HTML comment was treated as a real fence opener (fences were stripped before
 * comments), blanking every valid heading after the comment. A real parser
 * handles fenced code, indented code, HTML comments, CRLF, and setext headings
 * natively, so all of those cases are correct by construction rather than by
 * accumulating special cases.
 *
 * Comparison rule: the section constants include the `## ` prefix (e.g.
 * `'## Changes'`), which is the single source of truth. We strip that prefix to
 * get the bare name and require the parsed heading text to equal it EXACTLY
 * (after trimming surrounding whitespace — GitHub-flavoured headings routinely
 * carry a trailing space, and the parser already drops ATX closing hashes). So
 * `### Changes` (depth 3), `## Changesss` (longer), a mid-line mention, and a
 * decorated `## Changes (menu producer)` / `## Changes are intentionally
 * omitted` all correctly FAIL to satisfy. The false-NEGATIVE risk of the exact
 * match (a human writing a decorated heading) is mitigated by a finding message
 * naming the bare-heading requirement — see below.
 *
 * What the check does NOT require: the ATX `## ` syntax specifically. A setext
 * heading (a line underlined with `---`) and an inline-formatted heading
 * (`## **Changes**`) both parse to a top-level `depth === 2` heading reading
 * `Changes`, so both SATISFY — they render as real level-2 sections and
 * rejecting them would reintroduce the false-negative over-rejection this change
 * exists to prevent. The finding message therefore names a top-level level-2
 * heading whose text is exactly the section name as the contract, recommending
 * the bare `## Changes` form as the simplest way to meet it — it does not claim
 * the line must literally be `## Changes`.
 */

/** Bare section name from a constant that carries the `## ` ATX prefix. */
function sectionName(section: string): string {
  return section.replace(/^#{1,6}\s*/, '').trim()
}

/**
 * Collect the trimmed plain text of every TOP-LEVEL level-2 heading — i.e. a
 * `heading` node with `depth === 2` that is a DIRECT child of the AST root.
 *
 * We deliberately do NOT recurse into containers. A depth-2 heading nested
 * inside a blockquote (`> ## Changes`) or a list item is quoted/embedded
 * content, not a document section, and must not satisfy the required-section
 * check — a recursive walk accepting it was the defect this fix addresses.
 *
 * Setext headings (a line underlined with `---`) and inline-formatted headings
 * (`## **Changes**`) ARE still accepted: both parse to a top-level `depth === 2`
 * heading whose `mdastToString` plain text is `Changes`, and both render as a
 * real level-2 section. Rejecting them would be over-strict and reintroduce the
 * false-negative over-rejection (darena #589) this whole change exists to
 * prevent — so restricting to top-level is the only tightening here.
 *
 * We pass `includeHtml: false` to `mdastToString` so an inline HTML comment in a
 * heading (`## Changes <!-- template note -->`, a common PR-template shape) is
 * NOT serialized into the text. Without it the comment string is appended and
 * the heading is wrongly rejected — a FALSE NEGATIVE that blocks a valid PR,
 * exactly the failure this deterministic check exists to eliminate. Dropping the
 * comment can leave stray whitespace where it stood (`Changes <!--x--> more` →
 * `Changes  more`), so we also collapse internal whitespace runs before the
 * exact-match compare; a heading that is ONLY a comment (`## <!-- Changes -->`)
 * correctly serializes to empty and still fails.
 */
function collectDepth2Headings(tree: Root): Set<string> {
  const headings = new Set<string>()
  for (const node of tree.children as Nodes[]) {
    if (node.type === 'heading' && node.depth === 2) {
      const text = mdastToString(node, { includeHtml: false }).replace(/\s+/g, ' ').trim()
      headings.add(text)
    }
  }
  return headings
}

function checkPrBodySections(prBody: string | undefined | null): ReviewFinding[] {
  const body = prBody ?? ''
  const findings: ReviewFinding[] = []

  // Parse once. A parse failure on pathological input must FAIL CLOSED — the
  // whole point of this deterministic check is that a missing required section
  // blocks the merge; treating an unparseable body as "all sections present"
  // would silently re-open the exact bypass this check exists to remove. So on
  // a throw we log, capture the error, and flag every required section missing.
  let present: Set<string>
  try {
    present = collectDepth2Headings(fromMarkdown(body) as Root)
  } catch (err) {
    console.error(
      `[ci-review] PR-body Markdown parse failed; treating all required sections as missing (fail-closed): ${err instanceof Error ? err.message : String(err)}`
    )
    present = new Set()
  }

  for (const section of PR_BODY_REQUIRED_SECTIONS) {
    // section already includes the `## ` prefix, e.g. "## Changes"; compare the
    // parsed heading text against the bare name. Exact match (trimmed) so a
    // decorated or longer heading does not satisfy — see the doc comment above.
    if (present.has(sectionName(section))) continue

    findings.push({
      file: 'PR_BODY',
      severity: 'high',
      category: 'pr-structure',
      description: `The PR body is missing the required \`${section}\` section. It needs a top-level level-2 Markdown heading whose text is EXACTLY \`${sectionName(section)}\` — the simplest way is a line containing only \`${section}\`. A decorated heading such as \`${section} (details)\` or \`${section} — notes\` does NOT count (move the extra text to the line below), and a heading nested inside a blockquote or list item (e.g. \`> ${section}\`) does NOT count — the heading must be a top-level section, not quoted or embedded content. Per docs/glossary.md "PR" recipe step 10, every PR body must contain ${PR_BODY_REQUIRED_SECTIONS.map((s) => `\`${s}\``).join(', ')}.`,
      suggested_fix: `Add a top-level level-2 heading reading exactly \`${sectionName(section)}\` (the plain form \`${section}\` on its own line), not nested inside a blockquote or list, and put any qualifier on the following line.`,
      line_range: section,
    })
  }

  return findings
}

// ── Prior PR reviews + comments (verdict cache, rebuttal memory) ─────────────

/** GET a paginated list endpoint; one JSON object per line via jq. Throws on failure. */
function ghApiList(endpoint: string, jq: string): Record<string, unknown>[] {
  const raw = execFileSync(
    'gh',
    ['api', `${endpoint}?per_page=100`, '--paginate', '--jq', `.[] | ${jq} | tojson`],
    { encoding: 'utf-8', timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }
  )
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function fetchPrReviews(repo: string, prNumber: string): PrReviewRecord[] {
  return ghApiList(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    '{id, login: .user.login, type: .user.type, state, body, submittedAt: .submitted_at}'
  ).map((r) => ({
    id: Number(r.id),
    login: String(r.login ?? ''),
    type: r.type ? String(r.type) : undefined,
    state: String(r.state ?? ''),
    body: String(r.body ?? ''),
    submittedAt: r.submittedAt ? String(r.submittedAt) : undefined,
  }))
}

function fetchPrComments(repo: string, prNumber: string): PrCommentRecord[] {
  return ghApiList(
    `repos/${repo}/issues/${prNumber}/comments`,
    '{login: .user.login, association: .author_association, body, createdAt: .created_at}'
  ).map((c) => ({
    login: String(c.login ?? ''),
    association: String(c.association ?? ''),
    body: String(c.body ?? ''),
    createdAt: c.createdAt ? String(c.createdAt) : undefined,
  }))
}

/**
 * Rebuttal memory for the model prompt. Fail-safe: a GitHub API failure logs a
 * warning and returns '' so the review proceeds without memory.
 */
function loadRebuttalContext(repo: string, prNumber: string, reviews?: PrReviewRecord[]): string {
  try {
    return buildRebuttalContext(
      fetchPrComments(repo, prNumber),
      reviews ?? fetchPrReviews(repo, prNumber),
      { botLogin: BOT_LOGIN, isTrustedAssociation: isTrustedApprovalAssociation }
    )
  } catch (err) {
    console.warn(
      `[ci-review] Rebuttal context fetch failed for ${repo}#${prNumber}; reviewing without it: ${err instanceof Error ? err.message : String(err)}`
    )
    return ''
  }
}

// ── Post PR review via GitHub CLI ───────────────────────────────────────────

/**
 * GitHub rejects APPROVE and REQUEST_CHANGES when the reviewer authored the PR
 * (422 "Can not request changes on your own pull request" / "approve your own").
 * The rc-international/ci sync PRs are opened by the same bot that reviews them.
 */
export function isOwnPrReviewError(err: unknown): boolean {
  const e = err as { message?: string; stdout?: unknown; stderr?: unknown }
  const text = `${e?.message ?? ''} ${String(e?.stdout ?? '')} ${String(e?.stderr ?? '')}`
  return /your own pull request/i.test(text)
}

export function ownPrCommentBody(event: 'REQUEST_CHANGES' | 'APPROVE', body: string): string {
  return `> Posted as a comment: GitHub does not let this bot ${event === 'APPROVE' ? 'approve' : 'request changes on'} its own pull request. Verdict: **${event}**.\n\n${body}`
}

async function postPrReview(
  prNumber: string,
  repo: string,
  event: 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE',
  body: string
): Promise<void> {
  try {
    const ghEvent = event === 'APPROVE' ? 'APPROVE' : event
    const payload = JSON.stringify({ event: ghEvent, body })
    execFileSync(
      'gh',
      ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', '-'],
      {
        encoding: 'utf-8',
        timeout: 15_000,
        input: payload,
      }
    )
    console.log(`[ci-review] Posted PR review (${event}) to ${repo}#${prNumber}`)
  } catch (err) {
    if (event !== 'COMMENT' && isOwnPrReviewError(err)) {
      // Fall back to a COMMENT carrying the verdict. A REQUEST_CHANGES verdict still
      // turns the check red (exitCode 1) so blocking findings stay visible.
      try {
        execFileSync(
          'gh',
          ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', '-'],
          {
            encoding: 'utf-8',
            timeout: 15_000,
            input: JSON.stringify({ event: 'COMMENT', body: ownPrCommentBody(event, body) }),
          }
        )
      } catch (fallbackErr) {
        // Same contract as the rethrow below: an unposted review must fail the check.
        console.error(
          `[ci-review] Own-PR COMMENT fallback also failed for ${repo}#${prNumber} (verdict ${event}): ${(fallbackErr as Error)?.message || fallbackErr}`
        )
        throw fallbackErr
      }
      console.log(`[ci-review] Own PR: posted ${event} verdict as COMMENT to ${repo}#${prNumber}`)
      if (event === 'REQUEST_CHANGES') process.exitCode = 1
      return
    }
    // Rethrow: an unposted review is a review that did not happen. The fatal
    // handler exits 1 so the required `code-review` check goes red instead of
    // green-with-no-review.
    console.error(`[ci-review] Failed to post PR review: ${(err as Error)?.message || err}`)
    throw err
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prNumber = process.env.PR_NUMBER
  const repo = process.env.GITHUB_REPOSITORY
  const apiKey = process.env.CI_REVIEW_DEEPINFRA_API_KEY || process.env.DEEPINFRA_API_KEY

  if (!prNumber || !repo) {
    console.error('[ci-review] PR_NUMBER and GITHUB_REPOSITORY must be set')
    process.exit(1)
  }

  if (process.env.GITHUB_EVENT_NAME === 'issue_comment') {
    const manualApproval = getManualApprovalFromEnv()
    if (!manualApproval) {
      console.log('[ci-review] Issue comment is not a trusted PR approval; skipping review.')
      process.exit(0)
    }

    await postPrReview(
      prNumber,
      repo,
      'APPROVE',
      [
        '## Manual Code Review Approval',
        '',
        `Accepted \`${APPROVAL_COMMENT}\` comment from rc-int ${manualApproval.association.toLowerCase()} \`${manualApproval.author}\`.`,
        '',
        'This is the manual fallback for times when the automated review is unavailable.',
      ].join('\n')
    )
    process.exit(0)
  }

  // Read diff from stdin or file argument
  let rawDiff = ''
  const diffArg = process.argv[2]
  if (diffArg && existsSync(diffArg)) {
    rawDiff = readFileSync(diffArg, 'utf-8')
  } else {
    // Read from stdin (piped from gh pr diff)
    try {
      rawDiff = execFileSync('gh', ['pr', 'diff', String(prNumber)], {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30_000,
      })
    } catch (err) {
      console.error(`[ci-review] Failed to get PR diff: ${(err as Error)?.message || err}`)
      process.exit(1)
    }
  }

  // Parse diff
  const diffInfo = parseDiff(rawDiff)

  // Deterministic placeholder-author guard — runs regardless of what changed.
  // Commit metadata is not visible to (or reliably judged by) the LLM reviewer,
  // so a stray-identity commit (e.g. author `Test <test@test.com>` from an agent
  // worktree's inherited git config) must be caught by code and BLOCK the merge.
  // These findings are merged into every code path below so they can't be
  // bypassed by an empty / docs-only / API-unavailable review.
  const authorFindings = resolveCommitAuthorFindings(prNumber)
  if (authorFindings.length > 0) {
    console.error(
      `[ci-review] Commit-author guard raised ${authorFindings.length} finding(s) — blocking clean approval.`
    )
  }

  // Deterministic always-required-section check — code answers "does the body
  // contain `## Changes`", the model no longer does (it hallucinated a missing
  // section on darena #589; see PR_STRUCTURE_RULE). Like the author guard, this
  // is established WITHOUT the model, so it is computed here — before the
  // no-API-key and API-error early exits — and merged into EVERY code path
  // below. A missing required section must block the merge even when the review
  // API is unavailable; letting it through on an unrelated outage would be the
  // same silent-bypass this deterministic check exists to remove.
  const prBody = getPrBody(prNumber)
  const prBodyFindings = checkPrBodySections(prBody)
  if (prBodyFindings.length > 0) {
    console.error(
      `[ci-review] PR-body section check raised ${prBodyFindings.length} finding(s): ${prBodyFindings.map((f) => f.line_range).join(', ')}`
    )
  }

  // All findings that do not depend on the LLM. If any exist, the review must
  // REQUEST_CHANGES no matter which downstream path (empty/docs/no-key/api-error)
  // is taken.
  const deterministicFindings = [...authorFindings, ...prBodyFindings]

  if (diffInfo.isEmpty) {
    console.log('[ci-review] Empty diff, skipping code review.')
    const event = deterministicFindings.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE'
    const body =
      deterministicFindings.length > 0
        ? formatReviewBody(deterministicFindings, { wasTruncated: false, fileCount: 0 })
        : '## Automated Code Review\n\nNo changes to review — approved.'
    await postPrReview(prNumber, repo, event, body)
    process.exit(0)
  }

  if (diffInfo.isDocsOnly) {
    console.log('[ci-review] Docs-only changes, skipping code review.')
    const event = deterministicFindings.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE'
    const body =
      deterministicFindings.length > 0
        ? formatReviewBody(deterministicFindings, {
            wasTruncated: false,
            fileCount: diffInfo.fileCount,
          })
        : '## Automated Code Review\n\nNo code changes to review (documentation only) — approved.'
    await postPrReview(prNumber, repo, event, body)
    process.exit(0)
  }

  if (!apiKey) {
    console.warn('[ci-review] CI_REVIEW_DEEPINFRA_API_KEY not set. Skipping LLM review.')
    // Even with the LLM unavailable, the author guard and the PR-body section
    // check are deterministic blocks — don't let them fall through to the
    // manual-approval path just because the model was skipped.
    if (reviewOutcomeWithoutModel(deterministicFindings) === 'REQUEST_CHANGES') {
      await postPrReview(
        prNumber,
        repo,
        'REQUEST_CHANGES',
        formatReviewBody(deterministicFindings, {
          wasTruncated: diffInfo.wasTruncated,
          fileCount: diffInfo.fileCount,
        })
      )
      process.exit(0)
    }
    await postPrReview(
      prNumber,
      repo,
      'COMMENT',
      `## Automated Code Review\n\nAutomated review skipped -- API unavailable.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`
    )
    process.exit(0)
  }

  // Build full file context for changed files
  const changedFiles = extractChangedFiles(rawDiff)
  const fileContents = new Map<string, string>()
  const fileContext = buildFileContext(changedFiles, fileContents)
  console.log(
    `[ci-review] Reviewing ${diffInfo.fileCount} files (${changedFiles.length} with full context, ${Math.round(fileContext.length / 1000)}KB)...`
  )

  // Verdict reuse: the PR's own prior bot reviews are the cache, keyed by
  // sha256(diff, prompt, models, file context, PR body, rebuttal memory).
  // Same key => same findings, no model call. A DISMISSED same-key review is
  // a bypass (the model re-runs with it as rebuttal context). A NEW maintainer
  // rebuttal changes the key, so it is always read by a fresh review.
  // Lookup failures fall through to a normal model review.
  const models = reviewModels(REVIEW_MODEL, FALLBACK_MODEL)
  let priorReviews: PrReviewRecord[] | undefined
  try {
    priorReviews = fetchPrReviews(repo, prNumber)
  } catch (err) {
    console.warn(
      `[ci-review] Prior-review lookup failed; reviewing without cache: ${(err as Error)?.message || err}`
    )
  }
  const rebuttalContext = loadRebuttalContext(repo, prNumber, priorReviews)
  if (rebuttalContext) {
    console.log(`[ci-review] Rebuttal memory: ${rebuttalContext.length} chars added to prompt.`)
  }
  const cacheKey = reviewCacheKey(rawDiff, models, fileContext, prBody, rebuttalContext)
  const { result, source } = await reviewWithCache<ReviewResult>({
    sha: cacheKey,
    botLogin: BOT_LOGIN,
    loadReviews: () => {
      if (!priorReviews) throw new Error('prior reviews unavailable')
      return priorReviews
    },
    callModel: async () => {
      const fresh = await callReviewModel(apiKey, diffInfo.cleanDiff, fileContext, prBody, {
        models,
        rebuttalContext,
      })
      if (fresh.apiError) return fresh
      // Deterministic post-model filters: drop what the diff/files disprove.
      return {
        ...fresh,
        findings: filterModelFindings(fresh.findings, rawDiff, diffInfo, fileContents),
      }
    },
  })

  if (result.apiError) {
    console.warn('[ci-review] review API failed. Posting skip notice.')
    // The author guard and PR-body section check are deterministic and must
    // still block even when the LLM review couldn't run. A missing required
    // section is a fact established without the model, so an unrelated API
    // outage must not silently let it through — that is exactly the bypass this
    // deterministic check exists to close.
    if (reviewOutcomeWithoutModel(deterministicFindings) === 'REQUEST_CHANGES') {
      await postPrReview(
        prNumber,
        repo,
        'REQUEST_CHANGES',
        formatReviewBody(deterministicFindings, {
          wasTruncated: diffInfo.wasTruncated,
          fileCount: diffInfo.fileCount,
        })
      )
      process.exit(0)
    }
    await postPrReview(
      prNumber,
      repo,
      'COMMENT',
      `## Automated Code Review\n\nAutomated review skipped -- API unavailable.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`
    )
    process.exit(0) // Don't fail the workflow on API issues
  }

  // Merge the deterministic author + PR-body findings with the LLM findings so
  // they participate in severity counting and REQUEST_CHANGES escalation.
  const findings = [...deterministicFindings, ...result.findings]
  // Only the (filtered) model findings go in the marker; deterministic findings
  // are recomputed on every run.
  const cacheMarker = encodeCacheMarker(cacheKey, result.findings)
  if (!cacheMarker) {
    console.warn('[ci-review] Cache marker too large for a review body; verdict not cached.')
  }
  console.log(`[ci-review] Verdict source: ${source}`)

  // Compute impact score (non-blocking: failures don't affect review)
  let impactScore: ImpactScore | undefined
  try {
    const commitMessages = getPrCommitMessages(prNumber)
    impactScore = computeImpactScore(diffInfo.cleanDiff, commitMessages, findings)
    console.log(`[ci-review] Impact score: ${impactScore.total}/100`)
  } catch (err) {
    console.warn(`[ci-review] Impact score computation failed: ${(err as Error)?.message || err}`)
  }

  const event = reviewEvent(findings)
  const body = formatReviewBody(findings, {
    wasTruncated: diffInfo.wasTruncated,
    fileCount: diffInfo.fileCount,
    impactScore,
    fallbackModel: result.model && result.model !== REVIEW_MODEL ? result.model : undefined,
    cacheMarker,
  })

  await postPrReview(prNumber, repo, event, body)

  // Log summary
  const logCounts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    'needs-verification': 0,
  }
  for (const f of findings) {
    logCounts[f.severity] = (logCounts[f.severity] || 0) + 1
  }
  console.log(
    `[ci-review] Review complete: ${findings.length} findings (critical=${logCounts.critical}, high=${logCounts.high}, medium=${logCounts.medium}, low=${logCounts.low}, needs-verification=${logCounts['needs-verification']})`
  )

  // Don't fail the workflow — the PR review itself communicates the findings
  process.exit(0)
}

// ── Exports for testing ─────────────────────────────────────────────────────

export {
  buildReviewPrompt,
  buildUserMessage,
  callReviewModel,
  getManualApprovalFromEnv,
  isApprovedComment,
  isTrustedApprovalAssociation,
  parseDiff,
  extractChangedFiles,
  buildFileContext,
  fetchPrReviews,
  fetchPrComments,
  loadRebuttalContext,
  filterModelFindings,
  reviewCacheKey,
  formatReviewBody,
  reviewEvent,
  reviewOutcomeWithoutModel,
  postPrReview,
  getPrCommitMessages,
  FALLBACK_MODEL,
  REVIEW_MODEL,
  getPrCommitAuthors,
  resolveCommitAuthorFindings,
  getPrBody,
  checkPrBodySections,
  CI_TIMEOUT_MS,
  type ReviewResult,
  type DiffInfo,
  type FormatOptions,
}
export {
  type CommitAuthor,
  checkCommitAuthors,
  isPlaceholderAuthor,
  isPlaceholderEmail,
  isPlaceholderName,
  PLACEHOLDER_EMAIL_DOMAINS,
  PLACEHOLDER_EMAILS,
  PLACEHOLDER_NAMES,
} from './lib/commit-author-guard.js'
export { computeImpactScore, formatImpactScore, type ImpactScore } from './lib/impact-score.js'
export type { ReviewFinding } from './lib/review-prompt.js'

// Only run main when executed directly
if (!process.env.__CI_REVIEW_TEST) {
  main().catch((err) => {
    // Exit 1: `code-review` is a required status check. A crash that exits 0
    // shows a green check although no review was posted. API outages are not
    // routed here — they post a skip notice and exit 0 inside main().
    console.error('[ci-review] Fatal error:', err)
    process.exit(1)
  })
}
