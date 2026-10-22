/**
 * Behaviour tests for the "Scan new commits for secrets" step in
 * .github/workflows/secret-scan.yml.
 *
 * WHY: the step decides WHICH commits get scanned and whether a scanner problem
 * fails the job. A wrong range lets a leaked key through unseen, and gitleaks
 * itself exits 0 with "no leaks found" when its internal `git log` fails. The
 * step's real `run:` script is read from the workflow file (not a copy) and run
 * against throwaway git repos with a planted fake AWS key. Nothing leaves the
 * machine.
 *
 * Needs the gitleaks binary: `GITLEAKS_BIN=/path/to/gitleaks bun test` or
 * gitleaks on PATH. The workflow pins 8.30.1; use that version.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = join(import.meta.dir, '../workflows/secret-scan.yml')
const ZERO = '0'.repeat(40)
// Built at runtime so this file does not contain a key-shaped literal.
const OLD_KEY = `${'AKIA'}${'Z3K7QWERTY2345AB'}`
const NEW_KEY = `${'AKIA'}${'Q7W2ERTYUI3456CD'}`

const GITLEAKS = process.env.GITLEAKS_BIN ?? Bun.which('gitleaks')

function scanScript(): string {
  const wf = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>
  }
  const step = wf.jobs['secret-scan'].steps.find((s) => s.name === 'Scan new commits for secrets')
  if (!step?.run) throw new Error('scan step not found in secret-scan.yml')
  return step.run
}

let root: string
let work: string
let runnerTemp: string
const sha: Record<string, string> = {}

function git(args: string[], cwd = work): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

function commit(file: string, content: string, msg: string): string {
  writeFileSync(join(work, file), content)
  git(['add', '-A'])
  git(['commit', '-q', '-m', msg])
  return git(['rev-parse', 'HEAD'])
}

beforeAll(() => {
  if (!GITLEAKS) throw new Error('gitleaks not found: set GITLEAKS_BIN or put gitleaks 8.30.1 on PATH')
  root = mkdtempSync(join(tmpdir(), 'secret-scan-'))
  runnerTemp = join(root, 'runner')
  mkdirSync(runnerTemp)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gitleaks'), `#!/usr/bin/env bash\nexec "${GITLEAKS}" "$@"\n`)
  chmodSync(join(bin, 'gitleaks'), 0o755)

  git(['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')], root)
  git(['clone', '-q', join(root, 'origin.git'), join(root, 'work')], root)
  work = join(root, 'work')
  commit('a.txt', 'hello\n', 'c0 clean')
  commit('old.env', `aws_key = ${OLD_KEY}\n`, 'c1 OLD leak (before the base)')
  git(['rm', '-q', 'old.env'])
  git(['commit', '-q', '-m', 'c2 remove old'])
  sha.base = git(['rev-parse', 'HEAD'])
  git(['push', '-q', 'origin', 'main'])
  git(['checkout', '-q', '-b', 'feat'])
  sha.clean = commit('a.txt', 'hello\nmore\n', 'p1 clean')
  commit('cfg.env', `aws_key = ${NEW_KEY}\n`, 'p2 PLANTED leak')
  sha.leak = commit('a.txt', 'hello\nmore\nx\n', 'p3 clean after leak')
  git(['push', '-q', 'origin', 'feat'])
  git(['fetch', '-q', 'origin'])
  process.env.PATH = `${bin}:${process.env.PATH}`
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function scan(env: Record<string, string>, script = scanScript()) {
  const p = Bun.spawn(['bash', '-c', script], {
    cwd: work,
    env: { ...process.env, RUNNER_TEMP: runnerTemp, PUSH_REF: 'refs/heads/feat', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: out + err }
}

const pr = (head: string) => ({ EVENT_NAME: 'pull_request', PR_BASE_SHA: sha.base, PR_HEAD_SHA: head })
const push = (before: string, after: string) => ({ EVENT_NAME: 'push', PUSH_BEFORE: before, PUSH_AFTER: after })

describe('secret-scan range selection', () => {
  // Mutation: scan `--all` instead of base..head -> the OLD leak fails the clean PR.
  test('PR: a planted key in the PR commits fails; the report is redacted', async () => {
    const r = await scan(pr(sha.leak))
    expect(r.code).toBe(1)
    expect(r.out).toContain('leaks found: 1')
    const report = readFileSync(join(runnerTemp, 'gitleaks.sarif'), 'utf8')
    expect(report).not.toContain(NEW_KEY)
  })

  test('PR: a clean range passes even though older history holds a leak', async () => {
    const r = await scan(pr(sha.clean))
    expect(r.code).toBe(0)
    expect(r.out).toContain('no leaks found')
  })

  test('push: before..after with a leak fails, a clean range passes', async () => {
    expect((await scan(push(sha.base, sha.leak))).code).toBe(1)
    expect((await scan(push(sha.base, sha.clean))).code).toBe(0)
  })

  // WHY: a new branch has before=000..; nothing may be skipped on the assumption
  // that another branch was scanned. The old leak in main history must show.
  test('push: new branch (zero SHA) scans all history reachable from the tip', async () => {
    const r = await scan(push(ZERO, sha.leak))
    expect(r.code).toBe(1)
    expect(r.out).toContain('leaks found: 2')
  })

  test('push: force-push (before not in the clone) scans all reachable history', async () => {
    const r = await scan(push('1'.repeat(40), sha.leak))
    expect(r.code).toBe(1)
    expect(r.out).toContain('leaks found: 2')
  })

  test('push: empty range (before == after) scans nothing and passes', async () => {
    const r = await scan(push(sha.leak, sha.leak))
    expect(r.code).toBe(0)
    expect(r.out).toContain('Nothing to scan')
  })

  test('push: branch deletion passes without scanning', async () => {
    expect((await scan(push(sha.leak, ZERO))).code).toBe(0)
  })

  test('an unsupported event fails closed', async () => {
    const r = await scan({ EVENT_NAME: 'schedule' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('supports pull_request and push only')
  })

  test('a malformed range fails closed', async () => {
    expect((await scan(pr(`${sha.leak} --bogus-flag`))).code).not.toBe(0)
  })
})

describe('secret-scan scanner errors', () => {
  // WHY: gitleaks exits 0 and prints "no leaks found" when its git log fails.
  // This fake gitleaks reproduces that. Mutation: delete the ERR grep guard in the
  // step -> exit code becomes 0 and this test fails.
  test('an ERR line from gitleaks fails the job even with exit 0', async () => {
    const fake = join(root, 'fake-bin')
    mkdirSync(fake, { recursive: true })
    writeFileSync(
      join(fake, 'gitleaks'),
      '#!/usr/bin/env bash\necho "2:23PM ERR [git] fatal: ambiguous argument" >&2\necho "2:23PM INF no leaks found"\nexit 0\n'
    )
    chmodSync(join(fake, 'gitleaks'), 0o755)
    const r = await scan({ ...pr(sha.clean), PATH: `${fake}:${process.env.PATH}` })
    expect(r.code).toBe(1)
    expect(r.out).toContain('refusing to treat the scan as clean')
  })
})

describe('secret-scan repo config', () => {
  test('a root .gitleaksignore with the fingerprint accepts that one finding', async () => {
    const rep = join(runnerTemp, 'fp.json')
    Bun.spawnSync(
      [GITLEAKS as string, 'git', '.', `--log-opts=${sha.base}..${sha.leak}`, '--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', rep],
      { cwd: work }
    )
    const fp = (JSON.parse(readFileSync(rep, 'utf8')) as { Fingerprint: string }[])[0].Fingerprint
    writeFileSync(join(work, '.gitleaksignore'), `${fp}\n`)
    try {
      const r = await scan(pr(sha.leak))
      expect(r.out).toContain('Using .gitleaksignore')
      expect(r.code).toBe(0)
    } finally {
      writeFileSync(join(work, '.gitleaksignore'), '')
    }
  })

  test('a root .gitleaks.toml allowlist applies; one for another path does not', async () => {
    const toml = (path: string) => `[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "fixture"\npaths = ['''${path}''']\n`
    try {
      writeFileSync(join(work, '.gitleaks.toml'), toml('cfg\\.env'))
      const ok = await scan(pr(sha.leak))
      expect(ok.out).toContain('Using .gitleaks.toml')
      expect(ok.code).toBe(0)
      writeFileSync(join(work, '.gitleaks.toml'), toml('nomatch\\.env'))
      expect((await scan(pr(sha.leak))).code).toBe(1)
    } finally {
      rmSync(join(work, '.gitleaks.toml'), { force: true })
    }
  })
})
