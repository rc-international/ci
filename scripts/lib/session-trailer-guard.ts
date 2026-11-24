/**
 * Deterministic SESSION-trailer guard (server-side mirror of the local
 * prepare-commit-msg hook scripts/session-trailer.sh).
 *
 * WHY: the local hook is bypassable (hook not installed, `--no-verify`, no
 * session env). Commits merged without a `SESSION:` trailer cannot be
 * joined to a session by the alert router or postmortems. Commit metadata is not something the LLM reviewer judges, so
 * this is code. Emits a `critical` finding per offending commit, which makes
 * ci-review.ts post REQUEST_CHANGES on the required `code-review` check.
 *
 * Exempt (explicit, logged via `exemptions`):
 *   - whole PRs CREATED before SESSION_TRAILER_ENFORCED_SINCE (history cannot be
 *     rewritten, so PRs open at rollout would be stuck). The boundary is the PR
 *     creation date, not a commit date: author dates are settable (GIT_AUTHOR_DATE,
 *     rebase -i, clock skew), created_at is not.
 *   - merge commits (parents > 1): GitHub merge / update-branch / `git subtree merge`
 *   - git-subtree squash commits (git-subtree-dir + git-subtree-split trailers)
 *   - authors whose API login is in BOT_AUTHOR_ALLOWLIST
 *
 * Decided NOT exempt (per case):
 *   - GitHub web-UI commits (Revert button, "Commit suggestion", web editor): the
 *     author adds `SESSION: manual-<user>-<YYYYMMDD>` in the commit message box.
 *   - `git cherry-pick -x` backports: -x keeps the original trailer and appends
 *     `(cherry picked from commit ...)` to the trailer block; hasSessionTrailer accepts it.
 */

import type { ReviewFinding } from './review-prompt'

export interface PrCommit {
  sha: string
  message: string
  /** Number of parents from the GitHub commits API. */
  parents: number
  /** GitHub API `author.login` (null when the author is not a GitHub user). */
  authorLogin: string | null
}

/** Shape check for one record parsed from `gh api` JSON; the cast alone proves nothing. */
export function isPrCommit(v: unknown): v is PrCommit {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.sha === 'string' &&
    typeof c.message === 'string' &&
    typeof c.parents === 'number' &&
    (c.authorLogin === null || typeof c.authorLogin === 'string')
  )
}

/** Bot logins whose commits need no SESSION trailer. Exact match, case-insensitive. */
export const BOT_AUTHOR_ALLOWLIST: readonly string[] = [
  'valors-release-bot[bot]',
  'dependabot[bot]',
  'github-actions[bot]',
  // Explicit exemption policy. Observed 2026-11-16: `gh search commits --owner rc-international
  // --author 'lovable-dev[bot]'` returns valors-co-pilot commits authored by gpt-engineer-app[bot]
  // (the Lovable platform writes these commit messages; we do not control them).
  'gpt-engineer-app[bot]',
]

/** Rollout date: PRs CREATED earlier are not checked. Owner announces before merge. */
export const SESSION_TRAILER_ENFORCED_SINCE = '2026-11-18T00:00:00Z'

/** Same shape scripts/session-trailer.sh accepts. Rejects `$VAR`, `${X:-}`, `<user>` placeholders and `unknown`. */
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/

/** Above this many offenders the findings collapse into one (the review body is capped at 65,536 chars). */
export const MAX_LISTED_OFFENDERS = 10

/**
 * True when the message ends with a git-parseable `SESSION:` trailer: the LAST paragraph
 * consists only of `Token: value` lines (plus indented continuations) and holds a real,
 * expanded value. Stricter than "a SESSION line anywhere": the alert router reads
 * `%(trailers:key=SESSION)`, which is empty when a wrapped paragraph swallows the line
 * (see scripts/session-trailer.sh).
 */
export function hasSessionTrailer(message: string): boolean {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p.trim() !== '')
  if (paragraphs.length < 2) return false // a lone paragraph is the subject, never a trailer block
  const lines = (paragraphs[paragraphs.length - 1] ?? '').split('\n')
  // `git cherry-pick -x` appends its marker inside the trailer block; git accepts `Token:value` without a space.
  const isTrailerLine = (l: string) =>
    /^[A-Za-z][A-Za-z0-9-]*:/.test(l) ||
    /^[ \t]+\S/.test(l) ||
    /^\(cherry picked from commit [0-9a-f]{7,64}\)$/.test(l)
  if (!lines.every(isTrailerLine)) return false
  // Exactly ONE SESSION trailer (key matched case-insensitively, as git does): git returns one value per trailer, so a second line (valid or
  // not) leaves the alert router with several ids and no way to pick one.
  const sessionAt = lines.flatMap((l, i) => (/^SESSION:/i.test(l) ? [i] : []))
  if (sessionAt.length !== 1) return false
  const at = sessionAt[0] ?? 0
  // git folds an indented continuation line into the value (`id\n  more`): the id must stand alone.
  if (/^[ \t]+\S/.test(lines[at + 1] ?? '')) return false
  return SESSION_ID.test((lines[at] ?? '').replace(/^SESSION:/i, '').trim())
}

export type ExemptionReason = 'merge' | 'subtree' | 'bot'

const SUBTREE_SQUASH = /^git-subtree-dir:[ \t]*\S/m

export function exemptionReason(c: PrCommit): ExemptionReason | null {
  if (c.parents > 1) return 'merge'
  if (SUBTREE_SQUASH.test(c.message) && /^git-subtree-split:[ \t]*[0-9a-f]{7,}/m.test(c.message)) {
    return 'subtree'
  }
  const login = (c.authorLogin ?? '').toLowerCase()
  if (login && BOT_AUTHOR_ALLOWLIST.includes(login)) return 'bot'
  return null
}

export interface SessionTrailerResult {
  findings: ReviewFinding[]
  /** One line per exempted commit (or PR), for the CI log. */
  exemptions: string[]
}

export interface SessionTrailerOptions {
  /** PR `created_at` (ISO). Unparseable = fail closed. */
  prCreatedAt: string
  /** Link to the PR commits tab, quoted when findings collapse. */
  prCommitsUrl?: string
}

const FIX_HINT =
  'Add the trailer: inside a companion session `SESSION: $COMPANION_SESSION_ID` (expanded, not literal); otherwise `SESSION: manual-<user>-<YYYYMMDD>`. For a commit made in the GitHub web UI (Revert button, suggestions, web editor) type that line, as the last paragraph, into the commit message box. Install the hook (wilco init) so scripts/session-trailer.sh adds it for you. Reword with git rebase -i (no amend on shared history) and re-push.'

export function checkSessionTrailers(
  commits: PrCommit[],
  opts: SessionTrailerOptions
): SessionTrailerResult {
  const created = Date.parse(opts.prCreatedAt)
  if (!Number.isFinite(created)) {
    return {
      exemptions: [],
      findings: [
        {
          file: 'COMMIT_TRAILERS',
          severity: 'high',
          category: 'session-trailer',
          description: `The SESSION-trailer guard could not read a valid PR creation date (got "${opts.prCreatedAt}"). It cannot tell whether this PR predates enforcement, so trailer-less commits cannot be ruled out.`,
          suggested_fix: 'Re-run the code-review workflow; verify the token can read the PR.',
          line_range: 'session-trailer-guard',
        },
      ],
    }
  }
  if (created < Date.parse(SESSION_TRAILER_ENFORCED_SINCE)) {
    return { findings: [], exemptions: ['PR exempt (created before enforcement)'] }
  }
  const offenders: string[] = []
  const exemptions: string[] = []
  for (const c of commits) {
    const sha = (c.sha || '').slice(0, 8) || '???????'
    const reason = exemptionReason(c)
    if (reason) {
      exemptions.push(`${sha} exempt (${reason})`)
      continue
    }
    if (!hasSessionTrailer(c.message)) offenders.push(sha)
  }
  if (offenders.length > MAX_LISTED_OFFENDERS) {
    const shown = offenders.slice(0, MAX_LISTED_OFFENDERS).join(', ')
    const link = opts.prCommitsUrl ? ` Full list: ${opts.prCommitsUrl}` : ''
    return {
      exemptions,
      findings: [
        {
          file: 'GIT_METADATA',
          severity: 'critical',
          category: 'session-trailer',
          description: `${offenders.length} commits have no \`SESSION: <id>\` trailer. First ${MAX_LISTED_OFFENDERS}: ${shown}.${link}`,
          suggested_fix: `${FIX_HINT} List them all: git log --format='%h %s' origin/main..HEAD, check each with git log -1 --format='%(trailers:key=SESSION,valueonly)'.`,
          line_range: offenders[0] ?? 'session-trailer-guard',
        },
      ],
    }
  }
  return {
    exemptions,
    findings: offenders.map((sha) => ({
      file: 'GIT_METADATA',
      severity: 'critical' as const,
      category: 'session-trailer',
      description: `Commit ${sha} has no \`SESSION: <id>\` trailer. Every non-merge, non-bot commit must carry one so it can be traced to its session.`,
      suggested_fix: FIX_HINT,
      line_range: sha,
    })),
  }
}
