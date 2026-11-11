/**
 * The org-wide business-outcome registry: ci `outcomes/org.yaml`, the owner's 20 outcomes
 * (plan 2026-11-11-business-outcome-tracking-20, C1). The PR outcome gate accepts these ids
 * beside a repo's own `config/business_outcomes.yaml` ids.
 *
 * Kept free of markdown/mdast imports on purpose: ci has no package manifest, so its pre-push
 * tests (`bun test eval .github/scripts`) can import this file and validate the real registry.
 * `yaml` is imported lazily, so a missing package becomes an error, not a crash.
 *
 * Copied byte for byte to the ci repo by scripts/sync-ci.sh. Edit it in wilco only.
 */

import { existsSync, readFileSync } from 'node:fs'

export const ORG_OUTCOME_TYPES = ['measured', 'unmeasured', 'milestone', 'human_reported'] as const
const ID_RE = /^o\d{2}_[a-z0-9]+(?:_[a-z0-9]+)*$/

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * Validate a parsed org registry. Returns every problem found, never throws.
 * Rules: unique `oNN_snake_name` ids; known `type`; `measure` ({adapter, description}) or
 * `blocker`; a measured outcome must name its `measure`, an unmeasured one its `blocker`.
 */
export function validateOrgOutcomes(doc: unknown): { ids: string[]; problems: string[] } {
  if (!isRec(doc) || !Array.isArray(doc.outcomes))
    return { ids: [], problems: ['org registry root must be a mapping with an `outcomes` list'] }
  const problems: string[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  doc.outcomes.forEach((raw, i) => {
    if (!isRec(raw)) {
      problems.push(`outcomes[${i}] is not a mapping`)
      return
    }
    const id = typeof raw.id === 'string' ? raw.id : `#${i}`
    const bad = (msg: string) => problems.push(`${id}: ${msg}`)
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id))
      bad('`id` must look like `o01_snake_name`')
    else if (seen.has(raw.id)) bad('duplicate id')
    else {
      seen.add(raw.id)
      ids.push(raw.id)
    }
    if (raw.week !== 1 && raw.week !== 2) bad('`week` must be 1 or 2')
    if (!nonEmpty(raw.statement)) bad('`statement` is empty')
    if (!nonEmpty(raw.target)) bad('`target` is empty')
    if (raw.target_source !== 'estimate' && raw.target_source !== 'measured')
      bad('`target_source` must be estimate or measured')
    if (
      !Array.isArray(raw.owner_repos) ||
      raw.owner_repos.length === 0 ||
      !raw.owner_repos.every(nonEmpty)
    )
      bad('`owner_repos` must be a non-empty list of repo names')
    if (!Number.isInteger(raw.window_days) || (raw.window_days as number) <= 0)
      bad('`window_days` must be a positive integer')
    const type = raw.type
    if (!(ORG_OUTCOME_TYPES as readonly unknown[]).includes(type))
      bad(`\`type\` must be one of ${ORG_OUTCOME_TYPES.join('|')}`)
    const hasMeasure =
      isRec(raw.measure) && nonEmpty(raw.measure.adapter) && nonEmpty(raw.measure.description)
    const hasBlocker = nonEmpty(raw.blocker)
    if (raw.measure !== undefined && !hasMeasure)
      bad('`measure` needs a non-empty `adapter` and `description`')
    if (!hasMeasure && !hasBlocker) bad('needs a `measure` or a `blocker`')
    else if (type === 'measured' && !hasMeasure) bad('a measured outcome needs a `measure`')
    else if (type === 'unmeasured' && !hasBlocker) bad('an unmeasured outcome needs a `blocker`')
  })
  return { ids, problems }
}

/** Loads the YAML parser. Injectable so tests can simulate a missing package. */
export type OrgYamlImporter = () => Promise<{ parse: (text: string) => unknown }>
const defaultImporter: OrgYamlImporter = () => import('yaml')

/**
 * Read the org outcome ids from `file`. Absent and not required: `ids: null`, no error (wilco
 * itself has no org file). Absent and required, unreadable, invalid or no `yaml`: `ids: null`
 * AND an error, so the gate reports it instead of silently skipping the id checks.
 */
export async function loadOrgOutcomeIds(
  file: string,
  opts: { required?: boolean; importYaml?: OrgYamlImporter } = {}
): Promise<{ ids: Set<string> | null; error?: string }> {
  if (!existsSync(file))
    return opts.required
      ? { ids: null, error: `org outcome registry not found at ${file}` }
      : { ids: null }
  let parse: (text: string) => unknown
  try {
    parse = (await (opts.importYaml ?? defaultImporter)()).parse
  } catch (err) {
    return {
      ids: null,
      error: `org outcome registry skipped: yaml unavailable (${err instanceof Error ? err.message : String(err)})`,
    }
  }
  try {
    const { ids, problems } = validateOrgOutcomes(parse(readFileSync(file, 'utf-8')))
    if (problems.length > 0)
      return {
        ids: null,
        error: `org outcome registry ${file} is invalid: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`,
      }
    return { ids: new Set(ids) }
  } catch (err) {
    return {
      ids: null,
      error: `org outcome registry ${file}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
