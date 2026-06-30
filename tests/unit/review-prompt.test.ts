import { describe, expect, test } from 'bun:test'
import { buildReviewPrompt, ENGINEERING_RULES, FALLBACK_PROMPT } from '../../scripts/lib/review-prompt'

// These tests guard the fleet-wide engineering rules that must be present in
// every CI code-review prompt. A HIGH finding from any of these rules triggers
// REQUEST_CHANGES in reviewEvent(), so the rule text must survive both the
// YAML-built prompt path and the fallback path.

describe('ENGINEERING_RULES export', () => {
  test('exports a non-trivial string flagged as HIGH', () => {
    expect(typeof ENGINEERING_RULES).toBe('string')
    expect(ENGINEERING_RULES.length).toBeGreaterThan(100)
    expect(ENGINEERING_RULES).toContain('Engineering rules (mandatory')
    expect(ENGINEERING_RULES).toContain('flag violations as HIGH')
  })

  test('covers all 14 rule categories', () => {
    expect(ENGINEERING_RULES).toContain('Unverified assumptions')
    expect(ENGINEERING_RULES).toContain('Silent error handling')
    expect(ENGINEERING_RULES).toContain('Missing timeouts on I/O')
    expect(ENGINEERING_RULES).toContain('Hardcoded environment-specific values')
    expect(ENGINEERING_RULES).toContain('5. Security.')
    expect(ENGINEERING_RULES).toContain('Missing tests')
    expect(ENGINEERING_RULES).toContain('Production-path changes without a verification story')
    expect(ENGINEERING_RULES).toContain('Dead, duplicated, or truncated code')
    expect(ENGINEERING_RULES).toContain('Bash set -e safety')
    expect(ENGINEERING_RULES).toContain('shared service pool')
    expect(ENGINEERING_RULES).toContain('COUNT(DISTINCT)')
    expect(ENGINEERING_RULES).toContain('Scheduled job not verified')
    expect(ENGINEERING_RULES).toContain('does not fail loud')
    expect(ENGINEERING_RULES).toContain('Merge-automation that ignores strict branch protection')
  })
})

describe('buildReviewPrompt injects engineering rules', () => {
  test('YAML-built prompt contains the engineering rules', () => {
    const prompt = buildReviewPrompt()
    expect(prompt).toContain('Engineering rules (mandatory')
    expect(prompt).toContain('shared service pool')
  })

  test('engineering rules survive the YAML fallback path', () => {
    const prompt = buildReviewPrompt('/nonexistent/path.yaml')
    expect(prompt).toContain('Engineering rules (mandatory')
    expect(prompt).toContain('shared service pool')
  })
})

describe('FALLBACK_PROMPT injects engineering rules', () => {
  test('contains the engineering rules marker', () => {
    expect(FALLBACK_PROMPT).toContain('Engineering rules (mandatory')
    expect(FALLBACK_PROMPT).toContain('shared service pool')
  })
})
