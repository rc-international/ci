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

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { computeImpactScore, formatImpactScore, type ImpactScore } from './lib/impact-score.js'
import { buildReviewPrompt, type ReviewFinding } from './lib/review-prompt.js'

// ── Configuration ────────────────────────────────────────────────────────────

const CEREBRAS_ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions'
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'zai-glm-4.7'
const CI_TIMEOUT_MS = 60_000
const MAX_CONTEXT_CHARS = 400_000 // ~100K tokens, well within 131K context limit
const MAX_DIFF_SIZE = MAX_CONTEXT_CHARS // kept as alias for parseDiff compat
const BUDGET_PER_FILE = 50_000 // cap individual file content in context
const RETRY_DELAY_MS = 2_000
const MAX_RETRIES = 1
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

interface CerebrasResult {
  findings: ReviewFinding[]
  apiError: boolean
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
  let match: RegExpExecArray | null
  while ((match = filePathRegex.exec(rawDiff)) !== null) {
    files.add(match[1])
  }
  return [...files]
}

function buildFileContext(changedFiles: string[]): string {
  const sections: string[] = []
  const budgetPerFile = BUDGET_PER_FILE

  for (const filePath of changedFiles) {
    if (DOC_EXTENSIONS.has(`.${filePath.split('.').pop()?.toLowerCase()}`)) continue
    try {
      const content = execSync(`git show HEAD:${filePath}`, {
        encoding: 'utf-8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      })
      const truncated =
        content.length > budgetPerFile
          ? `${content.slice(0, budgetPerFile)}\n... (truncated)`
          : content
      sections.push(`=== FILE: ${filePath} ===\n${truncated}`)
    } catch (e) {
      console.debug(`[ci-review] Could not read ${filePath} from HEAD, skipping:`, e)
    }
  }

  return sections.join('\n\n')
}

// ── Cerebras API call ────────────────────────────────────────────────────────

const REVIEW_PROMPT = buildReviewPrompt()

function buildUserMessage(diff: string, fileContext: string, prBody = ''): string {
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
  const diffBudget = MAX_CONTEXT_CHARS - fileContext.length
  if (diff.length > diffBudget) {
    parts.push(diff.slice(0, diffBudget))
    parts.push('\n\n... (diff truncated)')
  } else {
    parts.push(diff)
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

async function callCerebras(
  apiKey: string,
  diff: string,
  fileContext: string,
  prBody = ''
): Promise<CerebrasResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[ci-review] Retrying Cerebras API (attempt ${attempt + 1})...`)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CI_TIMEOUT_MS)

    try {
      const response = await fetch(CEREBRAS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: CEREBRAS_MODEL,
          messages: [
            { role: 'system', content: REVIEW_PROMPT },
            {
              role: 'user',
              content: buildUserMessage(diff, fileContext, prBody),
            },
          ],
          temperature: 0.1,
          max_completion_tokens: 8192,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.error(`[ci-review] Cerebras API returned ${response.status}: ${body.slice(0, 200)}`)
        if (attempt < MAX_RETRIES) continue
        return { findings: [], apiError: true }
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content?.trim() || ''

      // Extract JSON array from response
      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return { findings: [], apiError: false }

      const findings: ReviewFinding[] = JSON.parse(jsonMatch[0])
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
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.error(`[ci-review] Cerebras API timed out (${CI_TIMEOUT_MS / 1000}s limit)`)
      } else {
        console.error('[ci-review] Cerebras API error:', err?.message || err)
      }
      if (attempt < MAX_RETRIES) continue
      return { findings: [], apiError: true }
    } finally {
      clearTimeout(timeout)
    }
  }

  return { findings: [], apiError: true }
}

// ── Review formatting ───────────────────────────────────────────────────────

function reviewEvent(findings: ReviewFinding[]): 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE' {
  const hasCriticalOrHigh = findings.some((f) => f.severity === 'critical' || f.severity === 'high')
  return hasCriticalOrHigh ? 'REQUEST_CHANGES' : 'APPROVE'
}

interface FormatOptions {
  wasTruncated: boolean
  fileCount: number
  impactScore?: ImpactScore
}

function formatReviewBody(findings: ReviewFinding[], opts: FormatOptions): string {
  const lines: string[] = []
  lines.push('## Automated Code Review')
  lines.push('')
  lines.push('> This review was generated by the wilco CI code review pipeline.')
  lines.push('')

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
    return lines.join('\n')
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

  return lines.join('\n')
}

// ── Get PR commit messages ──────────────────────────────────────────────────

function getPrCommitMessages(prNumber: string): string[] {
  try {
    const json = execSync(
      `gh pr view ${prNumber} --json commits --jq '.commits[].messageHeadline'`,
      { encoding: 'utf-8', timeout: 10_000 }
    )
    return json.trim().split('\n').filter(Boolean)
  } catch (err) {
    console.debug(`[ci-review] PR commit messages fetch failed for #${prNumber}:`, err)
    return []
  }
}

function getPrBody(prNumber: string): string {
  try {
    return execSync(`gh pr view ${prNumber} --json body --jq '.body'`, {
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

// ── Post PR review via GitHub CLI ───────────────────────────────────────────

async function postPrReview(
  prNumber: string,
  repo: string,
  event: 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE',
  body: string
): Promise<boolean> {
  try {
    const ghEvent = event === 'APPROVE' ? 'APPROVE' : event
    const payload = JSON.stringify({ event: ghEvent, body })
    execSync(`gh api repos/${repo}/pulls/${prNumber}/reviews --method POST --input -`, {
      encoding: 'utf-8',
      timeout: 15_000,
      input: payload,
    })
    console.log(`[ci-review] Posted PR review (${event}) to ${repo}#${prNumber}`)
    return true
  } catch (err: any) {
    console.error(`[ci-review] Failed to post PR review: ${err?.message || err}`)
    return false
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prNumber = process.env.PR_NUMBER
  const repo = process.env.GITHUB_REPOSITORY
  const apiKey = process.env.CEREBRAS_API_KEY

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
        'This is the manual fallback for times when the Cerebras automated review is unavailable.',
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
      rawDiff = execSync(`gh pr diff ${prNumber}`, {
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      })
    } catch (err: any) {
      console.error(`[ci-review] Failed to get PR diff: ${err?.message || err}`)
      process.exit(1)
    }
  }

  // Parse diff
  const diffInfo = parseDiff(rawDiff)

  if (diffInfo.isEmpty) {
    console.log('[ci-review] Empty diff, skipping review.')
    await postPrReview(
      prNumber,
      repo,
      'APPROVE',
      '## Automated Code Review\n\nNo changes to review — approved.'
    )
    process.exit(0)
  }

  if (diffInfo.isDocsOnly) {
    console.log('[ci-review] Docs-only changes, skipping code review.')
    await postPrReview(
      prNumber,
      repo,
      'APPROVE',
      '## Automated Code Review\n\nNo code changes to review (documentation only) — approved.'
    )
    process.exit(0)
  }

  if (!apiKey) {
    console.warn('[ci-review] CEREBRAS_API_KEY not set. Skipping review.')
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
  const fileContext = buildFileContext(changedFiles)
  console.log(
    `[ci-review] Reviewing ${diffInfo.fileCount} files (${changedFiles.length} with full context, ${Math.round(fileContext.length / 1000)}KB)...`
  )
  const prBody = getPrBody(prNumber)
  const result = await callCerebras(apiKey, diffInfo.cleanDiff, fileContext, prBody)

  if (result.apiError) {
    console.warn('[ci-review] Cerebras API failed. Posting skip notice.')
    await postPrReview(
      prNumber,
      repo,
      'COMMENT',
      `## Automated Code Review\n\nAutomated review skipped -- API unavailable.\n\nAn rc-int member can comment \`${APPROVAL_COMMENT}\` to manually approve this PR.`
    )
    process.exit(0) // Don't fail the workflow on API issues
  }

  const { findings } = result

  // Compute impact score (non-blocking: failures don't affect review)
  let impactScore: ImpactScore | undefined
  try {
    const commitMessages = getPrCommitMessages(prNumber)
    impactScore = computeImpactScore(diffInfo.cleanDiff, commitMessages, findings)
    console.log(`[ci-review] Impact score: ${impactScore.total}/100`)
  } catch (err: any) {
    console.warn(`[ci-review] Impact score computation failed: ${err?.message || err}`)
  }

  const event = reviewEvent(findings)
  const body = formatReviewBody(findings, {
    wasTruncated: diffInfo.wasTruncated,
    fileCount: diffInfo.fileCount,
    impactScore,
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
  callCerebras,
  getManualApprovalFromEnv,
  isApprovedComment,
  isTrustedApprovalAssociation,
  parseDiff,
  formatReviewBody,
  reviewEvent,
  postPrReview,
  getPrCommitMessages,
  getPrBody,
  CI_TIMEOUT_MS,
  type CerebrasResult,
  type DiffInfo,
  type FormatOptions,
}
export { computeImpactScore, formatImpactScore, type ImpactScore } from './lib/impact-score.js'
export type { ReviewFinding } from './lib/review-prompt.js'

// Only run main when executed directly
if (!process.env.__CI_REVIEW_TEST) {
  main().catch((err) => {
    console.error('[ci-review] Fatal error:', err)
    process.exit(0) // Don't fail workflow on script errors
  })
}
