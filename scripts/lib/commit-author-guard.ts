/**
 * Deterministic commit-author guard.
 *
 * Validates the git author identity of every commit in a PR against a
 * placeholder blocklist. Agent worktrees can inherit a stray local git config
 * (e.g. `user.name=Test` / `user.email=test@test.com` — set by test fixtures or
 * a leaked GIT_* env) and commit under that identity. This has landed on `main`
 * three times. The CI code review must catch it DETERMINISTICALLY — commit
 * metadata is not something the LLM reviewer can see or reliably judge, so this
 * is code, not a prompt rule.
 *
 * Emits a `critical` ReviewFinding for each offending commit. A critical finding
 * makes ci-review.ts post a REQUEST_CHANGES review, which blocks merge under
 * branch protection.
 */

import type { ReviewFinding } from './review-prompt'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommitAuthor {
  /** Full commit SHA (or any length — shortened for display). */
  sha: string
  /** Author name (`%an`). */
  name: string
  /** Author email (`%ae`). */
  email: string
}

// ── Blocklist ─────────────────────────────────────────────────────────────────
// Kept as named consts so the list is trivial to extend. All matching is
// case-insensitive.

/** Exact email addresses that are always placeholders. */
export const PLACEHOLDER_EMAILS: readonly string[] = ['test@test.com']

/**
 * Email domains that are reserved/placeholder (RFC 2606 example domains, plus
 * the loopback and *.test.com / localhost identities agents fall back to).
 * Any email ending in `@<domain>` matches.
 */
export const PLACEHOLDER_EMAIL_DOMAINS: readonly string[] = [
  'example.com',
  'example.org',
  'localhost',
  'test.com',
]

/** Author names that are always placeholders (matched exactly, case-insensitive). */
export const PLACEHOLDER_NAMES: readonly string[] = ['test', 'unknown', 'user', 'root']

// ── Matchers ──────────────────────────────────────────────────────────────────

/**
 * True when the email is a placeholder: empty, an exact blocklisted address, or
 * on a blocklisted domain.
 */
export function isPlaceholderEmail(email: string): boolean {
  const e = (email || '').trim().toLowerCase()
  if (e === '') return true
  if (PLACEHOLDER_EMAILS.includes(e)) return true
  const at = e.lastIndexOf('@')
  if (at === -1) return false // no domain — not our concern beyond the empty case above
  const domain = e.slice(at + 1)
  return PLACEHOLDER_EMAIL_DOMAINS.includes(domain)
}

/** True when the name is a placeholder: empty or an exact blocklisted name. */
export function isPlaceholderName(name: string): boolean {
  const n = (name || '').trim().toLowerCase()
  if (n === '') return true
  return PLACEHOLDER_NAMES.includes(n)
}

/** True when either the author name or email is a placeholder. */
export function isPlaceholderAuthor(author: CommitAuthor): boolean {
  return isPlaceholderName(author.name) || isPlaceholderEmail(author.email)
}

// ── Finding builder ───────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return (sha || '').slice(0, 8) || '???????'
}

/**
 * Given the authors of every commit in the PR, return a `critical` finding for
 * each commit whose author name OR email is a placeholder. Returns an empty
 * array when all authors are valid.
 *
 * Pure function — no I/O. The caller fetches the commit list and feeds it here.
 */
export function checkCommitAuthors(commits: CommitAuthor[]): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  for (const c of commits) {
    if (!isPlaceholderAuthor(c)) continue
    const sha = shortSha(c.sha)
    const name = c.name?.trim() || '(empty)'
    const email = c.email?.trim() || '(empty)'
    findings.push({
      file: 'GIT_METADATA',
      severity: 'critical',
      category: 'commit-author',
      description: `Commit ${sha} has placeholder author '${name} <${email}>' — an agent worktree committed under a stray git config. This must not merge.`,
      suggested_fix:
        'Set the correct identity (git config user.name "<You>"; git config user.email "<you@…>"), then rewrite the author with: git commit --amend --reset-author (or git rebase --exec "git commit --amend --reset-author --no-edit" <base> for multiple commits), then re-push.',
      line_range: sha,
    })
  }
  return findings
}
