/**
 * Business-outcome PR structure (docs/design/business-outcome-linkage.md 4.2, 4.7).
 *
 * Every PR body carries a dedicated `## Business Outcomes` section. Inside it,
 * five line types are parsed DETERMINISTICALLY (code answers "is there a
 * Business outcome line", the model never does):
 *
 *   Business outcome: <kpi_id> <↑|↓|=> [via <gate_id>] [<±lo>..<±hi> | +N | per run:<tool>] within <N>(h|d) [from <activation>]
 *   Business outcome: none — <reason of at least 10 chars>
 *   Leading outcome:  <measure_id> [<metric>] <↑|↓|=> ... (same tail)
 *   Feeds:            <kpi_id> via <gate_id>
 *   Decision impact:  <decision_id> keeps|establishes|reverses|fulfils [— owner-approved: <link>]
 *   Ships dark:       <FLAG> (default off)
 *   Enables:          #<n> (<reason>)
 *
 * Rollout: the findings are ADVISORY (MEDIUM) until OUTCOME_ADVISORY_UNTIL.
 * Promotion to blocking is a one-line flip of OUTCOME_FINDINGS_SEVERITY to
 * 'high'. It is deliberately NOT date-driven: the rollout needs a look at the
 * false-finding rate first (spec section 5, step 6). `reverses` without an
 * owner-approved link is HIGH from day one regardless (spec 4.7).
 *
 * Pure functions only, apart from loadOutcomeRegistry (reads the checkout; `yaml`
 * is imported lazily so a missing package degrades to a finding, not a crash).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Nodes, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { ReviewFinding } from './review-prompt.js'

// ── Rollout knobs ────────────────────────────────────────────────────────────

export type OutcomeSeverity = 'medium' | 'high'

/** The ONE promotion switch: change to 'high' to make the advisory findings blocking. */
export const OUTCOME_FINDINGS_SEVERITY: OutcomeSeverity = 'medium'
/** Shown in advisory findings. Informational only; does not change behaviour. */
export const OUTCOME_ADVISORY_UNTIL = '2026-10-30'
export const BUSINESS_OUTCOMES_SECTION = '## Business Outcomes'

const ADVISORY_SUFFIX = (sev: OutcomeSeverity): string =>
  sev === 'medium' ? ` (advisory until ${OUTCOME_ADVISORY_UNTIL})` : ''

// ── Line grammar ─────────────────────────────────────────────────────────────

export interface OutcomeLine {
  kind: 'business' | 'leading' | 'feeds' | 'decision' | 'dark' | 'enables'
  raw: string
  /** True when a TBD-owner placeholder appears in the range or the window. */
  tbd: boolean
  none?: boolean
  reason?: string
  /** Leading outcome measure id. */
  id?: string
  kpi?: string
  dir?: string
  gate?: string
  range?: string
  perRun?: string
  withinN?: string
  withinUnit?: string
  from?: string
  decision?: string
  relation?: string
  approvalLink?: string
  flag?: string
  pr?: number
}

export type ParsedLine =
  | { ok: true; line: OutcomeLine }
  | { ok: false; keyword: string; raw: string; problem: string }

const KEYWORD_RE =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(Business outcome|Leading outcome|Feeds|Decision impact|Ships dark|Enables)(?::\*\*|\*\*:|:)\s*(.*?)\s*$/

const ID = '[a-z][a-z0-9_]*'
const NUM = '(?:\\d+(?:\\.\\d+)?%?|TBD-owner)'
const TAIL = new RegExp(
  `^(?:via\\s+(?<gate>${ID})\\s+)?` +
    `(?:(?<range>[+-]?${NUM}\\.\\.[+-]?${NUM}|[+-]${NUM})\\s+|per\\s+run:(?<tool>${ID})\\s+)?` +
    `within\\s+(?<n>\\d+|TBD-owner)\\s*(?<unit>[hd])\\b` +
    `(?:\\s+from\\s+(?<from>(?:(?:flag|deploy|run):)?${ID}))?` +
    `(?<rest>.*)$`
)
/** Text that may legitimately follow a structured line: end, or punctuation / a parenthetical. */
const REST_OK = /^\s*(?:$|[.(,;—–]|-\s)/
const LINK_RE = /^(?:https?:\/\/\S+|(?:[\w.-]+\/[\w.-]+)?#\d+)$/

/**
 * The link after `— owner-approved:`. Accepts a bare URL / `#n`, a Markdown link
 * `[text](url)` and an autolink `<url>`; a leading `(` and trailing `).,;`
 * (sentence or parenthesis punctuation) are stripped. The result still has to match LINK_RE
 * where it is used, so `owner-approved: yes` stays invalid.
 */
function approvalLink(rest: string): string | undefined {
  const after = /^\s*(?:[—–]|--?)\s*owner-approved:\s*(.+?)\s*$/.exec(rest)?.[1]
  if (!after) return undefined
  const token =
    /^\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/.exec(after)?.[1] ??
    /^<([^>\s]+)>/.exec(after)?.[1] ??
    /^\S+/.exec(after)?.[0]
  return token?.replace(/^\(+/, '').replace(/[).,;]+$/, '')
}

function tailFields(tail: string): Partial<OutcomeLine> | string {
  const m = TAIL.exec(tail)
  if (!m?.groups)
    return 'expected `[via <gate>] [<range> | per run:<tool>] within <N>(h|d) [from <activation>]`'
  const g = m.groups
  if (!REST_OK.test(g.rest ?? ''))
    return `unexpected text after the line: \`${(g.rest ?? '').trim().slice(0, 60)}\``
  const tbd = /TBD-owner/.test(`${g.range ?? ''} ${g.n ?? ''}`)
  return {
    gate: g.gate,
    range: g.range,
    perRun: g.tool,
    withinN: g.n,
    withinUnit: g.unit,
    from: g.from,
    tbd,
  }
}

/** Parse one line. Returns null when the line is not an outcome line at all. */
export function parseOutcomeLine(raw: string): ParsedLine | null {
  const km = KEYWORD_RE.exec(raw)
  if (!km) return null
  const keyword = km[1]
  const rest = km[2]
  const bad = (problem: string): ParsedLine => ({ ok: false, keyword, raw: raw.trim(), problem })
  const good = (f: Partial<OutcomeLine> & Pick<OutcomeLine, 'kind'>): ParsedLine => ({
    ok: true,
    line: { raw: raw.trim(), tbd: false, ...f },
  })

  switch (keyword) {
    case 'Business outcome': {
      const none = /^none\s*(?:[—–]|--?)\s*(.*)$/.exec(rest)
      if (/^none\b/.test(rest)) {
        const reason = none?.[1]?.trim() ?? ''
        if (reason.length < 10)
          return bad('`none` needs a reason of at least 10 characters: `none — <reason>`')
        return good({ kind: 'business', none: true, reason })
      }
      const m = new RegExp(`^(?<kpi>${ID})\\s+(?<dir>↑|↓|=)\\s+(?<tail>.*)$`).exec(rest)
      if (!m?.groups) return bad('expected `<kpi_id> <↑|↓|=> ...` or `none — <reason>`')
      const t = tailFields(m.groups.tail)
      if (typeof t === 'string') return bad(t)
      return good({ kind: 'business', kpi: m.groups.kpi, dir: m.groups.dir, ...t })
    }
    case 'Leading outcome': {
      const m = new RegExp(`^(?<id>${ID})(?:\\s+${ID})?\\s+(?<dir>↑|↓|=)\\s+(?<tail>.*)$`).exec(
        rest
      )
      if (!m?.groups) return bad('expected `<measure_id> <↑|↓|=> ...`')
      const t = tailFields(m.groups.tail)
      if (typeof t === 'string') return bad(t)
      return good({ kind: 'leading', id: m.groups.id, dir: m.groups.dir, ...t })
    }
    case 'Feeds': {
      const m = new RegExp(`^(?<kpi>${ID})\\s+via\\s+(?<gate>${ID})(?<rest>.*)$`).exec(rest)
      if (!m?.groups) return bad('expected `<kpi_id> via <gate_id>`')
      if (!REST_OK.test(m.groups.rest)) return bad('unexpected text after `<kpi_id> via <gate_id>`')
      return good({ kind: 'feeds', kpi: m.groups.kpi, gate: m.groups.gate })
    }
    case 'Decision impact': {
      const m = new RegExp(
        `^(?<d>${ID})\\s+(?<rel>keeps|establishes|reverses|fulfils)\\b(?<rest>.*)$`
      ).exec(rest)
      if (!m?.groups) return bad('expected `<decision_id> keeps|establishes|reverses|fulfils`')
      return good({
        kind: 'decision',
        decision: m.groups.d,
        relation: m.groups.rel,
        approvalLink: approvalLink(m.groups.rest),
      })
    }
    case 'Ships dark': {
      const m = /^(?<flag>[A-Z][A-Z0-9_]*)\s+\(default off\)(?<rest>.*)$/.exec(rest)
      if (!m?.groups) return bad('expected `<FLAG> (default off)`')
      return good({ kind: 'dark', flag: m.groups.flag })
    }
    case 'Enables': {
      const m = /^#(?<pr>\d+)\s+\((?<reason>[^)]+)\)(?<rest>.*)$/.exec(rest)
      if (!m?.groups) return bad('expected `#<n> (<reason>)`')
      return good({ kind: 'enables', pr: Number(m.groups.pr), reason: m.groups.reason })
    }
    default:
      return null
  }
}

// ── Locating the section ─────────────────────────────────────────────────────

interface BodyLines {
  /** False when the Markdown parse threw; callers skip outcome checks (the section check fails closed). */
  parsed: boolean
  hasSection: boolean
  section: string[]
  outside: string[]
}

const stripComments = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '')

/**
 * Template placeholders such as `<kpi_id>`, `<N>`, `<±lo>`, `<↑|↓|=>`, `<FLAG>`,
 * `<reason...>`. A line that still carries one is an unfilled template example,
 * not an outcome claim: skip it (the presence rule then fires). `<url>` is NOT a
 * placeholder, it is a legal owner-approved form.
 */
const PLACEHOLDER_RE = /<(?:[a-z][a-z0-9]*_id|N|FLAG|reason\b[^<>]*|[±↑↓=][^<>]*)>/

function sectionName(heading: string): string {
  return heading.replace(/^##\s+/, '')
}

function headingText(node: Nodes): string {
  // Plain text of the heading's children; HTML comments dropped, whitespace collapsed.
  const walk = (n: Nodes): string => {
    if (n.type === 'html') return ''
    if ('value' in n && typeof n.value === 'string') return n.value
    if ('children' in n) return (n.children as Nodes[]).map(walk).join('')
    return ''
  }
  return walk(node).replace(/\s+/g, ' ').trim()
}

/**
 * The source of a top-level node with every NESTED code or html block (inside a list item or blockquote)
 * replaced by blank lines, so a fenced example under a bullet never parses as an outcome claim.
 */
function blankNestedCode(body: string, node: Nodes, start: number, end: number): string {
  const holes: Array<[number, number]> = []
  // Block-level only: a `code` block anywhere, or an `html` block whose parent is a container (list item,
  // blockquote). Inline html inside a paragraph (e.g. a `<kpi_id>` placeholder) stays, so the placeholder
  // filter still sees it.
  const visit = (n: Nodes, parent?: Nodes): void => {
    const blockHtml =
      n.type === 'html' &&
      parent !== undefined &&
      parent.type !== 'paragraph' &&
      parent.type !== 'heading'
    if (n !== node && (n.type === 'code' || blockHtml)) {
      const s = n.position?.start.offset
      const e = n.position?.end.offset
      if (s !== undefined && e !== undefined) holes.push([s, e])
      return
    }
    if ('children' in n) for (const c of n.children as Nodes[]) visit(c, n)
  }
  visit(node)
  let out = ''
  let pos = start
  for (const [s, e] of holes.sort((a, b) => a[0] - b[0])) {
    out += body.slice(pos, s) + body.slice(s, e).replace(/[^\n]/g, '')
    pos = e
  }
  return out + body.slice(pos, end)
}

/**
 * Split the body into the lines of `## Business Outcomes` and the lines of
 * everything else. Fenced code and raw HTML blocks are ignored on both sides,
 * so template placeholders in comments never parse as outcome lines. Matches the
 * section heading with the same rules as checkPrBodySections: top-level depth 2.
 */
function splitBody(body: string): BodyLines {
  let tree: Root
  try {
    tree = fromMarkdown(body) as Root
  } catch (err) {
    console.error(
      `[ci-review] outcome-lines: Markdown parse failed, outcome checks skipped (section check fails closed): ${err instanceof Error ? err.message : String(err)}`
    )
    return { parsed: false, hasSection: false, section: [], outside: [] }
  }
  const want = sectionName(BUSINESS_OUTCOMES_SECTION)
  const section: string[] = []
  const outside: string[] = []
  let hasSection = false
  let inSection = false
  for (const node of tree.children as Nodes[]) {
    if (node.type === 'heading' && node.depth === 2) {
      inSection = headingText(node) === want
      if (inSection) hasSection = true
      continue
    }
    if (node.type === 'code' || node.type === 'html') continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    const lines = stripComments(blankNestedCode(body, node, start, end))
      .split(/\r?\n/)
      .filter((l) => !PLACEHOLDER_RE.test(l))
    ;(inSection ? section : outside).push(...lines)
  }
  return { parsed: true, hasSection, section, outside }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface OutcomeRegistry {
  /** kpi id -> gate ids */
  kpis: Map<string, Set<string>>
  /** decision id -> path globs */
  decisions: Map<string, string[]>
  /** activation id -> kind (flag|deploy|run). null = the registry has no activations section. */
  activations: Map<string, string> | null
  /** Registry defects found at load time (e.g. a decision with empty `paths`); each becomes a finding. */
  problems?: string[]
}

type Yaml = Record<string, unknown>
const asRecords = (v: unknown): Yaml[] =>
  Array.isArray(v) ? v.filter((x): x is Yaml => typeof x === 'object' && x !== null) : []
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const gateIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).flatMap((g) =>
    typeof g === 'string'
      ? [g]
      : typeof g === 'object' && g && typeof (g as Yaml).id === 'string'
        ? [(g as Yaml).id as string]
        : []
  )

type YamlParse = (text: string) => unknown
/** Loads the YAML parser. Injectable so tests can simulate a missing package. */
export type YamlImporter = () => Promise<{ parse: YamlParse }>
const defaultYamlImporter: YamlImporter = () => import('yaml')

function readYaml(parse: YamlParse, path: string): Yaml {
  const v = parse(readFileSync(path, 'utf-8'))
  // A scalar, null or list root would load as an empty registry and silently disable every check it feeds.
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(
      `${path}: registry root must be a mapping, got ${v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v}`
    )
  return v as Yaml
}

function yamlFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
    : []
}

/** A decision whose `paths` is missing, not an array, empty or holds non-strings guards nothing. */
function pathsProblem(id: string, paths: unknown): string | null {
  if (!Array.isArray(paths) || paths.length === 0)
    return `decision \`${id}\` has empty or non-array \`paths\`, so it guards no file`
  if (paths.some((p) => typeof p !== 'string' || p.trim() === ''))
    return `decision \`${id}\` has a non-string or empty entry in \`paths\``
  return null
}

/**
 * A top-level collection (`kpis`, `decisions`, `activations`) that is present but
 * not an array of objects with a string `id` would otherwise load as empty and
 * silently disable the checks it feeds. Absent (or null) is fine.
 */
function collectionProblems(name: string, v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return [`\`${name}\` is not a list, so every ${name} entry was ignored`]
  const bad = v.filter(
    (e) => typeof e !== 'object' || e === null || typeof (e as Yaml).id !== 'string'
  ).length
  return bad > 0
    ? [`\`${name}\` has ${bad} entr${bad === 1 ? 'y' : 'ies'} without a string \`id\``]
    : []
}

/**
 * Read the registry from the checkout (the PR head, so a registry change in the
 * same PR counts). Supports the spec's single `config/business_outcomes.yaml`
 * and the split `config/outcomes/{kpis,decisions,activations}/<id>.yaml` layout
 * (file stem = id). No files: registry null, no error. Unreadable, both layouts
 * present, or `yaml` unavailable: registry null AND an error, never a silent pass.
 * `yaml` is imported only when a registry file exists.
 */
export async function loadOutcomeRegistry(
  root: string,
  importYaml: YamlImporter = defaultYamlImporter
): Promise<{ registry: OutcomeRegistry | null; error?: string }> {
  const single = join(root, 'config/business_outcomes.yaml')
  const splitDir = join(root, 'config/outcomes')
  const hasSingle = existsSync(single)
  const hasSplit = existsSync(splitDir)
  if (!hasSingle && !hasSplit) return { registry: null }
  if (hasSingle && hasSplit)
    return {
      registry: null,
      error:
        'both registry layouts present: config/business_outcomes.yaml and config/outcomes/. Keep exactly one',
    }
  let parse: YamlParse
  try {
    parse = (await importYaml()).parse
  } catch (err) {
    return {
      registry: null,
      error: `registry checks skipped: yaml unavailable (${err instanceof Error ? err.message : String(err)})`,
    }
  }
  try {
    const problems: string[] = []
    if (hasSingle) {
      const y = readYaml(parse, single)
      const decisions = asRecords(y.decisions)
      for (const c of ['kpis', 'decisions', 'activations'] as const)
        problems.push(...collectionProblems(c, y[c]))
      for (const d of decisions) {
        const prob = pathsProblem(String(d.id), d.paths)
        if (prob) problems.push(prob)
      }
      return {
        registry: {
          kpis: new Map(asRecords(y.kpis).map((k) => [String(k.id), new Set(gateIds(k.gates))])),
          decisions: new Map(decisions.map((d) => [String(d.id), asStrings(d.paths)])),
          activations: Array.isArray(y.activations)
            ? new Map(asRecords(y.activations).map((a) => [String(a.id), String(a.kind ?? '')]))
            : null,
          problems,
        },
      }
    }
    const kpis = new Map<string, Set<string>>()
    const decisions = new Map<string, string[]>()
    const activations = new Map<string, string>()
    const stem = (f: string) => basename(f).replace(/\.ya?ml$/, '')
    for (const f of yamlFiles(join(splitDir, 'kpis')))
      kpis.set(stem(f), new Set(gateIds(readYaml(parse, join(splitDir, 'kpis', f)).gates)))
    for (const f of yamlFiles(join(splitDir, 'decisions'))) {
      const paths = readYaml(parse, join(splitDir, 'decisions', f)).paths
      const prob = pathsProblem(stem(f), paths)
      if (prob) problems.push(prob)
      decisions.set(stem(f), asStrings(paths))
    }
    for (const f of yamlFiles(join(splitDir, 'activations')))
      activations.set(stem(f), String(readYaml(parse, join(splitDir, 'activations', f)).kind ?? ''))
    return {
      registry: {
        kpis,
        decisions,
        activations: existsSync(join(splitDir, 'activations')) ? activations : null,
        problems,
      },
    }
  } catch (err) {
    return { registry: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Findings ─────────────────────────────────────────────────────────────────

export interface OutcomeCheckOptions {
  registry?: OutcomeRegistry | null
  /** Paths changed by the PR, for the decision `paths` rule. */
  changedFiles?: string[]
  severity?: OutcomeSeverity
}

const finding = (
  severity: ReviewFinding['severity'],
  line_range: string,
  description: string,
  suggested_fix: string
): ReviewFinding => ({
  file: 'PR_BODY',
  severity,
  category: 'pr-structure',
  description,
  suggested_fix,
  line_range,
})

const MOVE_CAP = 5

/**
 * Glob match that never throws. A malformed glob (unbalanced `[` / `{`, or a
 * constructor that throws) is recorded in `bad` and counts as no match. Bun
 * silently returns false for an unbalanced glob, which would leave a decision
 * guarding nothing, so balance is checked here.
 */
function globMatches(glob: string, file: string, bad: Set<string>): boolean {
  const balanced = (open: string, close: string) => {
    let depth = 0
    for (const c of glob) {
      if (c === open) depth++
      else if (c === close && --depth < 0) return false
    }
    return depth === 0
  }
  if (!balanced('[', ']') || !balanced('{', '}')) {
    bad.add(glob)
    return false
  }
  try {
    return new Bun.Glob(glob).match(file)
  } catch (err) {
    console.error(`[ci-review] outcome-lines: invalid glob \`${glob}\` in registry: ${err}`)
    bad.add(glob)
    return false
  }
}

export function checkBusinessOutcomes(
  prBody: string | undefined | null,
  opts: OutcomeCheckOptions = {}
): ReviewFinding[] {
  const sev = opts.severity ?? OUTCOME_FINDINGS_SEVERITY
  const adv = ADVISORY_SUFFIX(sev)
  const split = splitBody(prBody ?? '')
  if (!split.parsed) return []
  const out: ReviewFinding[] = []
  const S = BUSINESS_OUTCOMES_SECTION

  const parse = (lines: string[]) =>
    lines.map(parseOutcomeLine).filter((p): p is ParsedLine => p !== null)
  const inSection = parse(split.section)
  const outside = parse(split.outside)

  // Section absent: checkPrBodySections owns that finding, nothing more to say.
  if (split.hasSection) {
    for (const p of inSection) {
      if (!p.ok)
        out.push(
          finding(
            sev,
            S,
            `Unparseable \`${p.keyword}:\` line in \`${S}\`: \`${p.raw}\` — ${p.problem}${adv}.`,
            `Rewrite it to the grammar in docs/glossary.md "Business Outcomes".`
          )
        )
    }
    const hasBusiness = inSection.some((p) => p.ok && p.line.kind === 'business')
    if (!hasBusiness)
      out.push(
        finding(
          sev,
          S,
          `\`${S}\` has no valid \`Business outcome:\` line${adv}. Every PR needs one, even a trivial PR: \`Business outcome: none — <reason of at least 10 chars>\`.`,
          'Add `Business outcome: <kpi_id> <↑|↓|=> ... within <N>(h|d)` or `Business outcome: none — <reason>`.'
        )
      )
  }

  // Lines elsewhere (e.g. inside Expected Outcomes) must move into the section.
  if (outside.length > 0) {
    for (const p of outside.slice(0, MOVE_CAP)) {
      const raw = p.ok ? p.line.raw : p.raw
      out.push(
        finding(
          sev,
          S,
          `Outcome line outside \`${S}\`: \`${raw.slice(0, 120)}\` — move it into the \`${S}\` section${adv}.`,
          `Move the line under a top-level \`${S}\` heading.`
        )
      )
    }
    if (outside.length > MOVE_CAP)
      out.push(
        finding(
          sev,
          S,
          `${outside.length - MOVE_CAP} more outcome line(s) outside \`${S}\` — move them too${adv}.`,
          `Move them under \`${S}\`.`
        )
      )
  }

  // TBD-owner placeholders are allowed but must not go unnoticed.
  for (const p of inSection) {
    if (p.ok && p.line.tbd)
      out.push(
        finding(
          'low',
          S,
          `TBD-owner placeholder in \`${p.line.raw.slice(0, 120)}\`: the owner must fill the threshold or window before the outcome can be measured.`,
          'Replace TBD-owner with the owner-approved value, or leave it and track the follow-up.'
        )
      )
  }

  // reverses needs an owner-approved link. HIGH from day one (spec 4.7), anywhere in the body.
  for (const p of [...inSection, ...outside]) {
    if (
      p.ok &&
      p.line.relation === 'reverses' &&
      !(p.line.approvalLink && LINK_RE.test(p.line.approvalLink))
    )
      out.push(
        finding(
          'high',
          S,
          `\`Decision impact: ${p.line.decision} reverses\` has no valid owner-approved link. Reversing a registered decision needs \`— owner-approved: <link>\` (a URL or #<pr>/#<issue>) to the owner's approval.`,
          'Append `— owner-approved: <link to the approval>`, or change the relation if this PR does not reverse the decision.'
        )
      )
  }

  // Registry-backed checks (only when the repo has a registry).
  const reg = opts.registry
  if (reg) {
    const miss = (what: string, id: string, hint: string) =>
      out.push(
        finding(
          sev,
          S,
          `Unknown ${what} \`${id}\`: not in the outcome registry${hint}${adv}.`,
          `Use an id that exists in the registry, or add it to the registry in this PR.`
        )
      )
    const checkKpiGate = (kpi: string | undefined, gate: string | undefined) => {
      if (!kpi) return
      const gates = reg.kpis.get(kpi)
      if (!gates) return miss('kpi', kpi, '')
      if (gate && !gates.has(gate)) miss('gate', gate, ` for kpi \`${kpi}\``)
    }
    const checkActivation = (from: string | undefined) => {
      if (!from || !reg.activations) return
      const [kind, id] = from.includes(':')
        ? (from.split(':') as [string, string])
        : [undefined, from]
      const have = reg.activations.get(id)
      if (have === undefined) return miss('activation', from, '')
      if (kind && have && have !== kind)
        miss('activation', from, ` with kind \`${kind}\` (registered as \`${have}\`)`)
    }
    for (const p of [...inSection, ...outside]) {
      if (!p.ok) continue
      const l = p.line
      if (l.kind === 'business' && !l.none) {
        checkKpiGate(l.kpi, l.gate)
        checkActivation(l.from)
      } else if (l.kind === 'feeds') checkKpiGate(l.kpi, l.gate)
      else if (l.kind === 'leading') checkActivation(l.from)
      else if (l.kind === 'decision' && l.decision && !reg.decisions.has(l.decision))
        miss('decision', l.decision, '')
    }

    // A decision with empty / non-array `paths` guards nothing: say so instead of skipping it.
    for (const prob of reg.problems ?? [])
      out.push(
        finding(
          sev,
          S,
          `Outcome registry defect: ${prob}${adv}.`,
          'Give the decision a non-empty `paths` list of globs (`*` stays inside one directory, `**` crosses directories).'
        )
      )

    // A diff touching a decision's paths must state its Decision impact.
    const declared = new Set(
      [...inSection, ...outside].flatMap((p) =>
        p.ok && p.line.kind === 'decision' && p.line.decision ? [p.line.decision] : []
      )
    )
    const badGlobs = new Set<string>()
    for (const [id, globs] of reg.decisions) {
      if (declared.has(id)) continue
      const hit = (opts.changedFiles ?? []).find((f) =>
        globs.some((g) => globMatches(g, f, badGlobs))
      )
      if (hit)
        out.push(
          finding(
            sev,
            S,
            `The diff touches \`${hit}\`, a path guarded by decision \`${id}\`, but the body has no \`Decision impact: ${id} keeps|establishes|reverses|fulfils\` line${adv}.`,
            `Add \`Decision impact: ${id} keeps\` (or the relation that applies) to \`${S}\`.`
          )
        )
    }
    // Reported even for declared decisions: the glob guards nothing either way.
    for (const g of reg.decisions.values()) for (const x of g) globMatches(x, '', badGlobs)
    for (const g of badGlobs)
      out.push(
        finding(
          sev,
          S,
          `Invalid glob in registry: \`${g}\` is malformed, so the decision it belongs to guards nothing${adv}.`,
          'Fix the glob in the outcome registry (balanced `[]` and `{}`).'
        )
      )
  }

  return out
}

// ── Diff paths and registry tampering ────────────────────────────────────────

export interface DiffFileEntry {
  paths: string[]
  deleted: boolean
}

const cleanDiffPath = (raw: string, prefix: 'a/' | 'b/'): string | null => {
  // `--- a/x y<TAB>` : git appends a tab after names containing spaces. Quoted names lose the quotes.
  let p = raw.split('\t')[0].trim()
  if (p === '/dev/null') return null
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
  return p.startsWith(prefix) ? p.slice(2) : p
}

/**
 * Per-file changed paths from a unified diff. Takes BOTH `--- a/` and `+++ b/`
 * names plus `rename from/to`, so a rename into (or out of) a guarded path is
 * seen, and a path containing " b/" is not split at the wrong " b/" the way
 * `diff --git a/(.+?) b/` does. Falls back to the `diff --git` header
 * (equal names only) for mode-only and binary changes.
 */
export function diffFileEntries(rawDiff: string): DiffFileEntry[] {
  const entries: DiffFileEntry[] = []
  for (const section of rawDiff.split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue
    const paths = new Set<string>()
    let deleted = false
    let inHunk = false
    for (const line of section.split('\n')) {
      // After the first hunk header, `--- x` / `+++ x` are content lines, not file names.
      if (line.startsWith('@@')) inHunk = true
      if (inHunk) continue
      let p: string | null = null
      if (line.startsWith('--- ')) p = cleanDiffPath(line.slice(4), 'a/')
      else if (line.startsWith('+++ ')) {
        if (line.slice(4).trim() === '/dev/null') deleted = true
        p = cleanDiffPath(line.slice(4), 'b/')
      } else if (line.startsWith('rename from ') || line.startsWith('rename to '))
        p = cleanDiffPath(line.replace(/^rename (?:from|to) /, ''), 'a/')
      else if (line.startsWith('deleted file mode')) deleted = true
      if (p) paths.add(p)
    }
    if (paths.size === 0) {
      const same = /^diff --git a\/(.+) b\/\1$/.exec(section.split('\n')[0])
      if (same) paths.add(same[1])
    }
    if (paths.size > 0) entries.push({ paths: [...paths], deleted })
  }
  return entries
}

/** Union of every path the diff touches (old and new names). */
export const diffChangedPaths = (rawDiff: string): string[] => [
  ...new Set(diffFileEntries(rawDiff).flatMap((e) => e.paths)),
]

const isRegistryPath = (p: string): boolean =>
  p === 'config/business_outcomes.yaml' || (p.startsWith('config/outcomes/') && /\.ya?ml$/.test(p))

/**
 * A PR that edits the registry is checked against its OWN registry, so deleting
 * or loosening an entry would pass every id check. Name the change. Removal of
 * the whole registry (or any registry file) uses the rollout severity; plain
 * edits are LOW so a reviewer sees them. Detection reads the diff, not the base
 * tree: a shallow CI checkout has no base to compare. Limitation: an edit that
 * only narrows a decision's `paths` is reported as a change, not as a narrowing.
 */
export function checkRegistryChanges(
  rawDiff: string,
  opts: { registry?: OutcomeRegistry | null; severity?: OutcomeSeverity } = {}
): ReviewFinding[] {
  const sev = opts.severity ?? OUTCOME_FINDINGS_SEVERITY
  const adv = ADVISORY_SUFFIX(sev)
  const touched = diffFileEntries(rawDiff).filter((e) => e.paths.some(isRegistryPath))
  const removed = touched.filter((e) => e.deleted).flatMap((e) => e.paths.filter(isRegistryPath))
  const edited = touched.filter((e) => !e.deleted).flatMap((e) => e.paths.filter(isRegistryPath))
  const out: ReviewFinding[] = []
  const S = BUSINESS_OUTCOMES_SECTION
  if (removed.length > 0)
    out.push(
      finding(
        sev,
        S,
        opts.registry
          ? `Registry file(s) removed in this PR: ${removed.map((f) => `\`${f}\``).join(', ')}. Ids are checked against the PR's own registry, so a removed entry hides what it guarded${adv}.`
          : `Registry removed: this PR deletes ${removed.map((f) => `\`${f}\``).join(', ')} and leaves no registry, so no kpi, gate, decision or path check ran${adv}.`,
        'Restore the registry, or get the owner to approve removing it and say so in the PR body.'
      )
    )
  if (edited.length > 0)
    out.push(
      finding(
        'low',
        S,
        `This PR changes the outcome registry: ${edited.map((f) => `\`${f}\``).join(', ')}. Id and decision-path checks ran against the PR's own version of it; confirm the change is intended and owner-approved.`,
        'Review the registry diff for removed ids, removed gates or narrowed `paths`.'
      )
    )
  return out
}

// ── F19: owner-attribution provenance ────────────────────────────────────────

// Bare "per owner" is deliberately NOT here: it matches code ("one lock per owner").
const OWNER_CLAIM_RE = /\b(?:owner\s+(?:decided|said|held)|owner\s+\d{4}-\d{2}-\d{2})\b/i
/** A link, an issue/PR reference, or an explicit decision id on the same line. */
const PROVENANCE_RE = /https?:\/\/\S+|(?:^|[^\w&])#\d+\b|\bdecision:[a-z][a-z0-9_]*/i
const MAX_PROVENANCE = 10

export function scanOwnerProvenance(
  rawDiff: string,
  commitMessages: string[],
  opts: { decisionIds?: Set<string>; severity?: OutcomeSeverity } = {}
): ReviewFinding[] {
  const sev = opts.severity ?? OUTCOME_FINDINGS_SEVERITY
  const adv = ADVISORY_SUFFIX(sev)
  const ids = opts.decisionIds ?? new Set<string>()
  const out: ReviewFinding[] = []
  const unsourced = (line: string): boolean => {
    if (!OWNER_CLAIM_RE.test(line)) return false
    if (PROVENANCE_RE.test(line)) return false
    for (const id of ids) if (line.includes(id)) return false
    return true
  }
  const fix =
    'Link the owner statement (URL or #<n>) on the same line, cite a registry decision id, or drop the attribution.'
  const msg = (where: string, text: string) =>
    `Unsourced owner attribution in ${where}: \`${text.trim().slice(0, 140)}\`. A claim that the owner decided something needs a link or registry id on the same line${adv}.`

  let file = ''
  let lineNo = 0
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = ''
      continue
    }
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) {
      lineNo = Number(hunk[1]) - 1
      continue
    }
    if (!file || line.startsWith('--- ') || line.startsWith('\\')) continue
    if (line.startsWith('-')) continue
    lineNo += 1
    if (line.startsWith('+') && unsourced(line.slice(1))) {
      out.push({
        file,
        severity: sev,
        category: 'pr-structure',
        description: msg(`\`${file}\``, line.slice(1)),
        suggested_fix: fix,
        line_range: String(lineNo),
      })
    }
  }
  for (const m of commitMessages) {
    const headline = m.split('\n')[0]
    const bad = m.split('\n').find(unsourced)
    if (bad)
      out.push({
        file: 'COMMIT_MESSAGE',
        severity: sev,
        category: 'pr-structure',
        description: msg('a commit message', bad),
        suggested_fix: fix,
        line_range: headline,
      })
  }
  if (out.length > MAX_PROVENANCE) {
    const extra = out.length - MAX_PROVENANCE
    return [
      ...out.slice(0, MAX_PROVENANCE),
      {
        ...out[0],
        file: 'PR_BODY',
        line_range: 'provenance',
        description: `${extra} more unsourced owner attribution(s) not listed${adv}.`,
      },
    ]
  }
  return out
}
