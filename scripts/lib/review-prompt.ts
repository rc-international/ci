/**
 * Shared review prompt builder.
 *
 * Single source of truth for diff review prompts used by:
 * - pre-push session review (Cerebras)
 * - CI code review (Cerebras)
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
 * Standardized output schema description for all diff review prompts.
 * Uses snake_case to match review_findings DB columns.
 */
export const REVIEW_OUTPUT_SCHEMA = `Output ONLY a JSON array of findings. Each finding must have:
- "file": the filename from the diff
- "severity": "critical" | "high" | "medium" | "low" | "needs-verification"
- "category": short category name (e.g. "security", "error-handling", "testing", "logging", "hardcoded-value", "dead-code", "config", "data-integrity")
- "description": concise description of the issue
- "suggested_fix": brief suggestion for how to fix it
- "line_range": approximate line range from the diff (e.g. "+42-+55")`

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

Severity guide:
- critical: credential exposure, SQL injection, auth bypass, data loss risk, empty catch blocks
- high: missing input validation, no timeouts, hardcoded secrets/URLs, client-trusted auth context
- medium: missing tests, poor error messages, missing logging, magic numbers
- low: style issues, minor documentation gaps
- needs-verification: finding looks suspicious but evidence is inconclusive — reviewer should verify

If the code looks clean, return an empty array: []

Respond with ONLY the JSON array, no markdown fencing, no explanation.`

// ── Prompt builder ───────────────────────────────────────────────────────────

export function buildReviewPrompt(yamlPath?: string): string {
  const patterns = loadReviewPatterns(yamlPath)
  if (!patterns) return FALLBACK_PROMPT

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

  const additionalChecks = patterns['additional-checks']
  if (additionalChecks?.length) {
    lines.push('')
    lines.push('## Additional checks')
    for (const c of additionalChecks) {
      lines.push(`- ${c.description}`)
    }
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
  lines.push('If the code looks clean, return an empty array: []')
  lines.push('')
  lines.push('Respond with ONLY the JSON array, no markdown fencing, no explanation.')

  return lines.join('\n')
}
