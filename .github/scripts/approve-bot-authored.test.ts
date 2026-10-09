/**
 * Behaviour tests for the `approve-bot-authored` job in
 * .github/workflows/self-code-review.yml.
 *
 * WHY: the job records a human's approval on PRs opened by valors-release-bot
 * (the wilco -> ci sync PRs), which the bot cannot approve itself. It is the
 * only human gate on ci-review code that every org repo runs with the org app
 * key, so the tests prove it approves ONLY when an OWNER/MEMBER names the
 * current head commit, on the sync branch of this repo, and that comment text
 * can never execute. The step's real `run:` script is read from the workflow
 * file (not a copy) and run with a stub `gh`; nothing is sent to GitHub.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = join(import.meta.dir, '../workflows/self-code-review.yml')
const HEAD = `abcdef1234567890${'0'.repeat(24)}`

function stepScript(): string {
  const wf = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: Record<string, { steps: { run: string }[] }>
  }
  return wf.jobs['approve-bot-authored'].steps[0].run
}

const FAKE_GH = `#!/usr/bin/env bash
if [[ "$*" == *"/reviews --method POST"* ]]; then cat > "$OUT/approved"; exit 0; fi
if [[ "$*" == *"/comments --method POST"* ]]; then cat > "$OUT/replied"; exit 0; fi
printf '%s\\t%s\\t%s\\n' "$FAKE_HEAD" "$FAKE_REF" "$FAKE_REPO"
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approve-bot-'))
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(
  body: string,
  opts: { assoc?: string; ref?: string; repo?: string } = {}
): Promise<{ outcome: 'approve' | 'reply' | 'none'; commit?: string; code: number }> {
  const p = Bun.spawn(['bash', '-c', stepScript()], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      OUT: dir,
      GH_TOKEN: 'x',
      REPO: 'rc-international/ci',
      PR_NUMBER: '31',
      COMMENT_BODY: body,
      COMMENT_AUTHOR: 'rc-int',
      ASSOCIATION: opts.assoc ?? 'MEMBER',
      FAKE_HEAD: HEAD,
      FAKE_REF: opts.ref ?? 'sync/wilco-ci-review',
      FAKE_REPO: opts.repo ?? 'rc-international/ci',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await p.exited
  if (existsSync(join(dir, 'approved'))) {
    const review = JSON.parse(readFileSync(join(dir, 'approved'), 'utf8'))
    return { outcome: 'approve', commit: review.commit_id, code }
  }
  return { outcome: existsSync(join(dir, 'replied')) ? 'reply' : 'none', code }
}

describe('approve-bot-authored', () => {
  // Mutation: drop the head-prefix check -> a stale sha approves; the stale test fails.
  test('approves `approved <head prefix>` from a MEMBER, pinned to the head', async () => {
    const r = await run('approved abcdef1')
    expect(r).toEqual({ outcome: 'approve', commit: HEAD, code: 0 })
  })

  test('is case- and whitespace-insensitive like ci-review.ts', async () => {
    expect((await run('  Approved ABCDEF1234 ', { assoc: 'OWNER' })).outcome).toBe('approve')
  })

  // WHY: the job runs after the comment; a push in between must not be approved unseen.
  test('a bare `approved` is not an approval: it replies with the exact command', async () => {
    expect((await run('approved')).outcome).toBe('reply')
  })

  test('a sha that is not the current head is refused with a reply', async () => {
    expect((await run('approved 1234567')).outcome).toBe('reply')
  })

  // Mutation: accept any association -> CONTRIBUTOR approves; fails.
  test('only OWNER/MEMBER may approve', async () => {
    for (const assoc of ['CONTRIBUTOR', 'COLLABORATOR', 'NONE']) {
      expect((await run('approved abcdef1', { assoc })).outcome).toBe('none')
    }
  })

  // Mutation: drop the ref/repo guard -> another branch or a fork approves; fails.
  test('only the sync branch of this repo qualifies', async () => {
    expect((await run('approved abcdef1', { ref: 'evil-branch' })).outcome).toBe('none')
    expect((await run('approved abcdef1', { repo: 'attacker/ci' })).outcome).toBe('none')
  })

  test('other comments are ignored', async () => {
    expect((await run('not approved')).outcome).toBe('none')
  })

  // WHY: the comment is attacker-influenced text; it must never execute.
  test('shell metacharacters in the comment are inert', async () => {
    const marker = join(dir, 'pwned')
    await run(`approved $(touch ${marker})`)
    await run(`approved \`touch ${marker}\``)
    expect(existsSync(marker)).toBe(false)
  })
})
