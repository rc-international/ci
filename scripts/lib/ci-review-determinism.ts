/**
 * CI review determinism helpers.
 *
 * WHY: on menu-expert#408 (2026-10-09) three bot rounds each raised a NEW false
 * HIGH, two of them with no new commits: (a) findings on lines outside the diff,
 * (b) a claim that `set -e` was "implied" in a file with no `set -e`, (c) a grep
 * inside an `elif` condition under `set -e` that had already been rebutted on
 * communications-expert#318 and valors-invite#48. The prompt already forbids all
 * three; the model ignores it, and temperature 0.2 re-rolls on every rerun.
 * Code answers what code can answer: this module holds the pure pieces —
 * diff-keyed verdict reuse, post-model filters, rebuttal memory.
 */

import { createHash } from 'node:crypto'
import type { ReviewFinding } from './review-prompt.js'

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'needs-verification']

// ── Hunk parser ─────────────────────────────────────────────────────────────

/** File path -> new-side line numbers touched by the diff. */
export type ChangedLines = Map<string, Set<number>>

/**
 * Parse a unified diff into the new-side line numbers each file changes.
 * Added lines count by their own number; a deleted line counts as the new-side
 * line that now sits at the deletion point (so a finding about a removal is not
 * "out of diff"). Context lines only advance the counter.
 */
export function parseChangedLines(diff: string): ChangedLines {
  const files: ChangedLines = new Map()
  let current: Set<number> | null = null
  let oldLeft = 0
  let newLeft = 0
  let newLine = 0
  let oldLine = 0

  for (const line of diff.split('\n')) {
    // A truncated diff can leave a hunk's counts unmet; a new file header always resets.
    if (line.startsWith('diff --git ')) {
      oldLeft = 0
      newLeft = 0
    }
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: the leading char decides, never the content.
      const c = line[0]
      if (c === '+') {
        current?.add(newLine)
        newLine++
        newLeft--
      } else if (c === '-') {
        // A finding on deleted code may cite the OLD line numbers. Record both
        // the new-side deletion point and the old-side line: over-inclusion
        // only keeps a finding blocking, it never hides one.
        current?.add(newLine)
        current?.add(oldLine)
        oldLine++
        oldLeft--
      } else if (c === '\\') {
        // "\ No newline at end of file"
      } else {
        // Context line (a blank context line may arrive with its space stripped).
        newLine++
        oldLine++
        newLeft--
        oldLeft--
      }
      continue
    }

    const header = line.match(/^diff --git a\/.+? b\/(.+)$/)
    if (header) {
      current = files.get(header[1]) ?? new Set<number>()
      files.set(header[1], current)
      continue
    }
    const newPath = line.match(/^\+\+\+ b\/(.+)$/)
    if (newPath) {
      current = files.get(newPath[1]) ?? new Set<number>()
      files.set(newPath[1], current)
      continue
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLine = Number(hunk[3])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
    }
  }
  return files
}

/** "+42-+55" / "42-55" / "L42" -> [42, 55]. Null when the string has no digits. */
export function parseLineRange(range: string | undefined): [number, number] | null {
  const nums = (range ?? '').match(/\d+/g)?.map(Number)
  if (!nums || nums.length === 0) return null
  return [Math.min(...nums), Math.max(...nums)]
}

export function normalizePath(file: string): string {
  return file
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^(\.\/|[ab]\/)/, '')
    .replace(/:\d[\d,:+\-\s]*$/, '') // "file.sh:42" / "file.sh:42-50" -> "file.sh"
}

export const HUNK_SLACK_LINES = 3

export interface DroppedFinding {
  finding: ReviewFinding
  reason: string
}

export interface FilterOutcome {
  kept: ReviewFinding[]
  dropped: DroppedFinding[]
}

export interface HunkScopeOptions {
  /** The diff the model saw was cut at the size budget: absence proves nothing. */
  truncated?: boolean
  /** The RAW (untruncated, all files) diff, used to tell "not in the PR" from "not parsed". */
  rawDiff?: string
}

/** Demote a finding to the non-blocking tier, keeping it visible with the reason. */
function downgrade(f: ReviewFinding, why: string): ReviewFinding {
  if (f.severity === 'needs-verification') return f
  return {
    ...f,
    severity: 'needs-verification',
    description: `[${why}; was ${f.severity}, verify before acting] ${f.description}`,
  }
}

/**
 * Keep findings honest about the lines this PR changes. Nothing here silently
 * clears a finding unless the diff positively disproves it.
 * - PR_BODY findings are not about source lines: always kept.
 * - Critical findings are never dropped or downgraded.
 * - File absent from the changed set: dropped ONLY when the diff was not
 *   truncated AND the path does not occur anywhere in the raw diff; otherwise
 *   downgraded to needs-verification.
 * - Unparseable line_range: kept (and flagged in `notes`), never dropped on a guess.
 * - Range outside the file's changed lines (+/- HUNK_SLACK_LINES): downgraded
 *   to needs-verification, because line_range is approximate.
 */
export function filterByHunkScope(
  findings: ReviewFinding[],
  changed: ChangedLines,
  notes: string[] = [],
  opts: HunkScopeOptions = {}
): FilterOutcome {
  const kept: ReviewFinding[] = []
  const dropped: DroppedFinding[] = []
  for (const f of findings) {
    if (f.file === 'PR_BODY') {
      kept.push(f)
      continue
    }
    const path = normalizePath(f.file)
    const lines = changed.get(path)
    if (!lines) {
      if (f.severity === 'critical') {
        notes.push(`kept critical finding on ${f.file}: file is not in the parsed diff`)
        kept.push(f)
      } else if (opts.truncated || path === '' || (opts.rawDiff ?? '').includes(path)) {
        notes.push(
          `downgraded ${f.severity} on ${f.file} to needs-verification: file not in parsed changed set (${opts.truncated ? 'diff truncated' : 'path occurs in raw diff'})`
        )
        kept.push(downgrade(f, `File ${f.file} not confirmed as changed by this PR`))
      } else {
        dropped.push({ finding: f, reason: `out-of-diff: ${f.file} is not changed by this PR` })
      }
      continue
    }
    const range = parseLineRange(f.line_range)
    if (!range) {
      notes.push(`kept ${f.file}: line_range ${JSON.stringify(f.line_range)} is unparseable`)
      kept.push(f)
      continue
    }
    const [lo, hi] = range
    let hit = false
    for (const n of lines) {
      if (n >= lo - HUNK_SLACK_LINES && n <= hi + HUNK_SLACK_LINES) {
        hit = true
        break
      }
    }
    if (hit || f.severity === 'critical') {
      if (!hit)
        notes.push(`kept critical finding on ${f.file} ${f.line_range}: outside changed lines`)
      kept.push(f)
    } else {
      // The prompt calls line_range "approximate", so a miss may be a real
      // finding with off line numbers: downgrade, never drop.
      notes.push(
        `downgraded ${f.severity} on ${f.file} ${f.line_range} to needs-verification: outside changed lines (+/-${HUNK_SLACK_LINES})`
      )
      kept.push(downgrade(f, `Outside the changed lines (${f.line_range})`))
    }
  }
  return { kept, dropped }
}

// ── set -e applicability ────────────────────────────────────────────────────

const SET_E_TEXT = /\bset\s+-[A-Za-z]*e[A-Za-z]*\b|\bset\s+-o\s+errexit\b|\bset[-_]e\b|\berrexit\b/i

/** True when the finding argues from `set -e` / errexit semantics. */
export function isSetEFinding(f: ReviewFinding): boolean {
  return SET_E_TEXT.test(`${f.rule_id ?? ''}\n${f.category}\n${f.description}`)
}

/** True when the file turns errexit on: `set -e`, `set -euo`, `set -o errexit`, `sh -e`, `#!/bin/sh -e`. */
export function fileEnablesErrexit(content: string): boolean {
  return (
    /\bset\s+-[A-Za-z]*e/.test(content) ||
    /\berrexit\b/.test(content) ||
    /^#!.*\s-[A-Za-z]*e/m.test(content) ||
    /\b(?:bash|zsh|dash|sh)\s+-[A-Za-z]*e/.test(content)
  )
}

const ERREXIT = String.raw`(?:set\s+-[A-Za-z]*e[A-Za-z]*|set\s+-o\s+errexit|set[-_]e|errexit)`
// "no / without / missing / lacks / add / enable ... set -e" (within one sentence).
const ERREXIT_MISSING_BEFORE = new RegExp(
  String.raw`\b(?:no|without|missing|lacks?|lacking|absent|add|adds|adding|enable|enables|needs?|requires?|omits?|omitted|not\s+(?:use|using|set|setting|enable|enabling|have|having)|(?:does|do|did|is|are)n['\u2019]t\s+(?:use|set|enable|have))\b[^.\n]{0,40}?${ERREXIT}`,
  'i'
)
// "set -e is missing / absent / not set / needed".
const ERREXIT_MISSING_AFTER = new RegExp(
  String.raw`${ERREXIT}[^.\n]{0,30}?\b(?:missing|absent|not\s+(?:set|enabled|present|used|active)|needed|required)\b`,
  'i'
)

/** True when the finding SAYS errexit is missing/needed rather than assuming it is on. */
export function claimsErrexitMissing(f: ReviewFinding): boolean {
  const text = `${f.rule_id ?? ''}\n${f.category}\n${f.description}`
  return ERREXIT_MISSING_BEFORE.test(text) || ERREXIT_MISSING_AFTER.test(text)
}

/**
 * A finding that ASSUMES errexit is on, about a file that never enables it, is
 * downgraded to needs-verification (errexit can still come from the invoker, the
 * shebang or a sourced library, so it is not dropped). A finding that says
 * set -e is missing/needed is untouched. Critical findings are never touched. Without the
 * file content there is no evidence either way: the finding is kept as is.
 */
export function filterSetEApplicability(
  findings: ReviewFinding[],
  fileContents: Map<string, string>,
  notes: string[] = []
): FilterOutcome {
  const kept: ReviewFinding[] = []
  const dropped: DroppedFinding[] = []
  for (const f of findings) {
    const content = fileContents.get(normalizePath(f.file))
    if (
      content !== undefined &&
      f.severity !== 'critical' &&
      isSetEFinding(f) &&
      !claimsErrexitMissing(f) &&
      !fileEnablesErrexit(content)
    ) {
      notes.push(`downgraded ${f.severity} on ${f.file} to needs-verification: no set -e in file`)
      kept.push(
        downgrade(f, `${f.file} never enables set -e/errexit; it may come from the invoker`)
      )
    } else {
      kept.push(f)
    }
  }
  return { kept, dropped }
}

export interface PostModelFilterInput {
  changedLines: ChangedLines
  fileContents: Map<string, string>
  /** The diff the model saw was truncated (see filterByHunkScope). */
  truncated?: boolean
  /** RAW diff (all files); see filterByHunkScope. */
  rawDiff?: string
  /** Drop log sink; default console.log with the [ci-review] prefix. */
  log?: (message: string) => void
}

/** Run every deterministic post-model filter and log each drop with its reason. */
export function applyPostModelFilters(
  findings: ReviewFinding[],
  input: PostModelFilterInput
): FilterOutcome {
  const log = input.log ?? ((m: string) => console.log(`[ci-review] ${m}`))
  const notes: string[] = []
  const scope = filterByHunkScope(findings, input.changedLines, notes, {
    truncated: input.truncated,
    rawDiff: input.rawDiff,
  })
  const setE = filterSetEApplicability(scope.kept, input.fileContents, notes)
  const dropped = [...scope.dropped, ...setE.dropped]
  for (const n of notes) log(`Filter note: ${n}`)
  for (const d of dropped) {
    log(
      `Dropped ${d.finding.severity} finding on ${d.finding.file} (${d.finding.line_range ?? '?'}): ${d.reason}`
    )
  }
  return { kept: setE.kept, dropped }
}

// ── Cache key + marker ──────────────────────────────────────────────────────

/** Bump to invalidate every stored verdict (filters or finding shape changed). */
export const CACHE_MARKER_VERSION = 'v2'
/** GitHub caps a review body at 65536 chars; keep the marker well under it. */
export const MAX_MARKER_CHARS = 30_000

export interface CacheKeyInput {
  /** The RAW diff (all files), not the size-capped copy the model sees. */
  diff: string
  prompt: string
  models: string[]
  /** Full-file context sent to the model (hashed in). */
  fileContext?: string
  /** CI_REVIEW_REASONING_EFFORT; it changes the model's output. */
  reasoning?: string
  /** PR body: the model reads it, so an edited body is a different review. */
  prBody?: string
  /** Rebuttal memory sent to the model: a new maintainer rebuttal must force a fresh review. */
  rebuttalContext?: string
}

/** sha256 over every input that can change the model's verdict. */
export function computeCacheKey(input: CacheKeyInput): string {
  const h = createHash('sha256')
  const parts = [
    CACHE_MARKER_VERSION,
    input.diff,
    input.prompt,
    input.models.join('\n'),
    input.fileContext ?? '',
    input.reasoning ?? '',
    input.prBody ?? '',
    input.rebuttalContext ?? '',
  ]
  for (const part of parts) {
    h.update(`${part.length}:`)
    h.update(part)
  }
  return h.digest('hex')
}

export function encodeCacheMarker(sha: string, findings: ReviewFinding[]): string | null {
  const b64 = Buffer.from(JSON.stringify(findings), 'utf-8').toString('base64')
  const marker = `<!-- ci-review-cache ${CACHE_MARKER_VERSION} sha=${sha} findings=${b64} -->`
  return marker.length <= MAX_MARKER_CHARS ? marker : null
}

// Anchored to the END of the (trimmed) body: the bot appends the marker last, so
// a marker quoted earlier in the body (e.g. inside a PR_BODY finding) never counts.
const MARKER_RE = new RegExp(
  `<!-- ci-review-cache ${CACHE_MARKER_VERSION} sha=([0-9a-f]{64}) findings=([A-Za-z0-9+/=]*) -->$`
)

/**
 * Neutralise HTML-comment delimiters in text that originates from the model (or
 * the PR) before it goes into a review body, so it can never open or close a
 * comment and smuggle a cache marker.
 */
export function neutralizeHtmlComments(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')
}

/** Copy of a finding with every free-text field comment-neutralised. */
export function sanitizeFindingForBody(f: ReviewFinding): ReviewFinding {
  const out: Record<string, unknown> = { ...f }
  for (const k of [
    'file',
    'line_range',
    'description',
    'suggested_fix',
    'evidence',
    'failure_scenario',
    'category',
    'rule_id',
  ]) {
    if (typeof out[k] === 'string') out[k] = neutralizeHtmlComments(out[k] as string)
  }
  return out as unknown as ReviewFinding
}

function isFindingShape(x: unknown): x is ReviewFinding {
  const f = x as Record<string, unknown> | null
  return (
    !!f &&
    typeof f.file === 'string' &&
    typeof f.category === 'string' &&
    typeof f.description === 'string' &&
    typeof f.severity === 'string' &&
    SEVERITIES.includes(f.severity)
  )
}

/** Null when there is no marker, it is malformed, or the findings are not finding-shaped. */
export function decodeCacheMarker(
  body: string | null | undefined
): { sha: string; findings: ReviewFinding[] } | null {
  const m = (body ?? '').trim().match(MARKER_RE)
  if (!m) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(m[2], 'base64').toString('utf-8'))
    if (!Array.isArray(parsed) || !parsed.every(isFindingShape)) return null
    return { sha: m[1], findings: parsed }
  } catch (e) {
    console.debug('[ci-review] Ignoring malformed cache marker:', e)
    return null
  }
}

// ── Verdict reuse ───────────────────────────────────────────────────────────

export interface PrReviewRecord {
  id: number
  login: string
  /** GitHub account type (`user.type`); only 'Bot' reviews are trusted. */
  type?: string
  state: string
  body: string
  submittedAt?: string
}

export interface PrCommentRecord {
  login: string
  association: string
  body: string
  createdAt?: string
}

/** A review we trust as our own: a GitHub Bot account whose login is the bot's. */
export function isTrustedBotReview(r: PrReviewRecord, botLogin: string): boolean {
  return r.type === 'Bot' && sameLogin(r.login, botLogin)
}

export function sameLogin(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\[bot\]$/, '')
  return norm(a) === norm(b)
}

function newestFirst<T extends { createdAt?: string; submittedAt?: string; id?: number }>(
  items: T[]
): T[] {
  const ts = (x: T) => Date.parse(x.submittedAt ?? x.createdAt ?? '') || 0
  return [...items].sort((a, b) => ts(b) - ts(a) || (b.id ?? 0) - (a.id ?? 0))
}

export type CacheDecision =
  | { kind: 'reuse'; findings: ReviewFinding[]; reviewId: number }
  | { kind: 'dismissed'; reviewId: number }
  | { kind: 'miss' }

/**
 * The newest trusted bot review carrying a marker with this sha decides. A
 * DISMISSED review is NOT a cache hit: dismissal is a rebuttal (fed to the model
 * as context), never an approval, so the model runs again. Anything else is
 * reused verbatim.
 */
export function decideCache(
  sha: string,
  reviews: PrReviewRecord[],
  botLogin: string
): CacheDecision {
  for (const r of newestFirst(reviews)) {
    if (!isTrustedBotReview(r, botLogin)) continue
    const marker = decodeCacheMarker(r.body)
    if (!marker || marker.sha !== sha) continue
    const state = r.state.toUpperCase()
    if (state === 'PENDING') continue
    if (state === 'DISMISSED') return { kind: 'dismissed', reviewId: r.id }
    return { kind: 'reuse', findings: marker.findings, reviewId: r.id }
  }
  return { kind: 'miss' }
}

export interface ModelOutcome {
  findings: ReviewFinding[]
  apiError: boolean
  model?: string
}

export type VerdictSource = 'reuse' | 'model'

/**
 * Review through the PR-as-cache. A failure to read prior reviews only costs the
 * cache: it logs a warning and runs the model (never skips or blocks a review).
 */
export async function reviewWithCache<R extends ModelOutcome>(opts: {
  sha: string
  botLogin: string
  loadReviews: () => PrReviewRecord[] | Promise<PrReviewRecord[]>
  callModel: () => Promise<R>
  log?: (message: string) => void
}): Promise<{ result: R | ModelOutcome; source: VerdictSource }> {
  const log = opts.log ?? ((m: string) => console.log(`[ci-review] ${m}`))
  let decision: CacheDecision = { kind: 'miss' }
  try {
    decision = decideCache(opts.sha, await opts.loadReviews(), opts.botLogin)
  } catch (err) {
    console.warn(
      `[ci-review] Cache lookup failed, running a normal model review: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (decision.kind === 'reuse') {
    log(
      `Cache hit (sha ${opts.sha.slice(0, 12)}): reusing ${decision.findings.length} finding(s) from review ${decision.reviewId}; no model call.`
    )
    return { result: { findings: decision.findings, apiError: false }, source: 'reuse' }
  }
  if (decision.kind === 'dismissed') {
    log(
      `Review ${decision.reviewId} for this diff was dismissed: not a cache hit. Its findings go to the model as rebuttal context and the model runs again.`
    )
  }
  log(
    `Cache ${decision.kind === 'dismissed' ? 'bypass' : 'miss'} (sha ${opts.sha.slice(0, 12)}): calling the model.`
  )
  return { result: await opts.callModel(), source: 'model' }
}

// ── Rebuttal memory ─────────────────────────────────────────────────────────

export const REBUTTAL_MAX_CHARS = 6000
const REBUTTAL_ITEM_MAX_CHARS = 1500
const REBUTTAL_RE = /rebut|false positive/i

const REBUTTAL_HEADER = `## Previously rebutted on this PR

Maintainers rebutted or dismissed the findings below. Do NOT re-raise a finding that matches one of them unless the CHANGED lines in the diff give new evidence. If you re-raise one, cite the rebuttal and state the new evidence.

`

/**
 * Build the "Previously rebutted" section: trusted-association comments that say
 * rebut / false positive, plus bodies of DISMISSED bot reviews. Newest first,
 * hard-capped at maxChars including the header. Empty string when nothing matches.
 */
export function buildRebuttalContext(
  comments: PrCommentRecord[],
  reviews: PrReviewRecord[],
  opts: {
    botLogin: string
    isTrustedAssociation: (association: string | undefined) => boolean
    maxChars?: number
  }
): string {
  const maxChars = opts.maxChars ?? REBUTTAL_MAX_CHARS
  const entries: { when: string; text: string }[] = []

  for (const c of newestFirst(comments)) {
    if (!opts.isTrustedAssociation(c.association)) continue
    if (!REBUTTAL_RE.test(c.body)) continue
    entries.push({ when: c.createdAt ?? '', text: `[comment by ${c.login}] ${c.body}` })
  }
  for (const r of newestFirst(reviews)) {
    if (!isTrustedBotReview(r, opts.botLogin) || r.state.toUpperCase() !== 'DISMISSED') continue
    // Structured findings from the marker, never the free-text body.
    const marker = decodeCacheMarker(r.body)
    if (!marker || marker.findings.length === 0) continue
    for (const f of marker.findings) {
      // A dismissal needs only write access and GitHub does not say who did
      // it. Never let it suppress a CRITICAL: those are re-reviewed from
      // scratch, not fed back as "do not re-raise".
      if (f.severity === 'critical') continue
      entries.push({
        when: r.submittedAt ?? '',
        text: `[findings a maintainer dismissed] ${f.severity} ${f.file} (${f.line_range ?? '?'}) ${f.category}: ${f.description.slice(0, 400)}`,
      })
    }
  }
  if (entries.length === 0) return ''

  entries.sort((a, b) => (Date.parse(b.when) || 0) - (Date.parse(a.when) || 0))

  let out = REBUTTAL_HEADER
  for (const e of entries) {
    const room = maxChars - out.length
    if (room < 200) break
    const item = `- ${e.text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, Math.min(REBUTTAL_ITEM_MAX_CHARS, room - 3))}\n`
    out += item
  }
  return out.length > REBUTTAL_HEADER.length ? out : ''
}
