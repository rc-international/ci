/**
 * verify-sync-pr.sh auto-approves wilco -> ci sync PRs. It is a merge gate for
 * the repo that hosts every org's reusable CI workflows, so the tests prove it
 * REFUSES anything that is not a byte-identical copy of reviewed wilco code.
 * A fake `gh` serves canned API answers from a JSON fixture; the approve POST
 * is recorded, never sent. Each test names the mutation that breaks it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'verify-sync-pr.sh')
const WSHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const SYNC_SH = [
  'publish() { git -C "$WILCO_DIR" show "$SRC_REF:$1" > "$CI_REPO_DIR/$2"; }',
  'publish scripts/ci-review.ts scripts/ci-review.ts',
  'publish scripts/lib/review-prompt.ts scripts/lib/review-prompt.ts',
  'publish rules/terse-briefings.md scripts/lib/terse-briefings.md',
].join('\n')

// Fake gh: answers `gh api <path>` from $FIX (a JSON map path-prefix -> output);
// a POST to /reviews is appended to $FIX.posted and succeeds.
const FAKE_GH = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"--method POST"* ]]; then cat > "$FIX.posted"; exit 0; fi
path="$2"
out=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=sys.argv[2]
for k,v in d.items():
    if p.split("?")[0]==k.split("?")[0] and (("?" not in k) or k==p):
        print(v); sys.exit(0)
sys.exit(1)' "$FIX" "$path") || exit 1
printf '%s\\n' "$out"
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-sync-'))
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type Fixture = Record<string, string>
function fixture(over: Fixture = {}, files = 'modified scripts/ci-review.ts\nmodified scripts/lib/review-prompt.ts'): Fixture {
  return {
    'repos/rc-international/wilco/commits/aaaaaaa': WSHA,
    [`repos/rc-international/wilco/contents/scripts/sync-ci.sh?ref=${WSHA}`]: Buffer.from(SYNC_SH).toString('base64'),
    'repos/rc-international/ci/pulls/7/files': files,
    [`repos/rc-international/ci/contents/scripts/ci-review.ts?ref=${HEAD}`]: 'blob1',
    [`repos/rc-international/wilco/contents/scripts/ci-review.ts?ref=${WSHA}`]: 'blob1',
    [`repos/rc-international/ci/contents/scripts/lib/review-prompt.ts?ref=${HEAD}`]: 'blob2',
    [`repos/rc-international/wilco/contents/scripts/lib/review-prompt.ts?ref=${WSHA}`]: 'blob2',
    ...over,
  }
}

async function run(fix: Fixture, title = 'chore(ci-review): sync review scripts from wilco aaaaaaa') {
  const fixPath = join(dir, 'fix.json')
  // `--jq .sha` / `--jq .content` / `--jq '...'` are applied by the real gh;
  // the fixture already stores the post-jq value.
  writeFileSync(fixPath, JSON.stringify(fix))
  const p = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FIX: fixPath,
      PR_NUMBER: '7',
      PR_TITLE: title,
      HEAD_SHA: HEAD,
      REPO: 'rc-international/ci',
      WILCO_REPO: 'rc-international/wilco',
      READ_TOKEN: 'r',
      APPROVE_TOKEN: 'a',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await p.exited
  const err = await new Response(p.stderr).text()
  const posted = existsSync(`${fixPath}.posted`) ? readFileSync(`${fixPath}.posted`, 'utf8') : null
  return { code, err, posted }
}

describe('verify-sync-pr.sh', () => {
  // Mutation: replace the blob comparison with `true` -> a tampered file is approved; the tamper test fails.
  test('approves an exact copy, pinned to the verified head commit', async () => {
    const r = await run(fixture())
    expect(r.code).toBe(0)
    expect(r.posted).not.toBeNull()
    const body = JSON.parse(r.posted as string)
    expect(body.event).toBe('APPROVE')
    expect(body.commit_id).toBe(HEAD)
  })

  test('refuses when a file differs from wilco (tampered copy)', async () => {
    const r = await run(fixture({ [`repos/rc-international/ci/contents/scripts/ci-review.ts?ref=${HEAD}`]: 'EVIL' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain('differs from wilco')
    expect(r.posted).toBeNull()
  })

  // Mutation: drop the SRC map check -> a workflow file rides along; fails.
  test('refuses a file that is not a sync-ci.sh destination', async () => {
    const r = await run(fixture({}, 'modified scripts/ci-review.ts\nmodified .github/workflows/code-review.yml'))
    expect(r.code).toBe(1)
    expect(r.err).toContain('not a sync-ci.sh destination')
    expect(r.posted).toBeNull()
  })

  // Mutation: allow any status -> a deletion is approved; fails.
  test('refuses removed or renamed files', async () => {
    const r = await run(fixture({}, 'removed scripts/ci-review.ts'))
    expect(r.code).toBe(1)
    expect(r.err).toContain('only added/modified')
  })

  test('refuses a title that names no wilco commit', async () => {
    const r = await run(fixture(), 'chore: sync review scripts')
    expect(r.code).toBe(1)
    expect(r.err).toContain('does not name a wilco commit')
  })

  test('refuses a wilco commit that does not exist', async () => {
    const f = fixture()
    delete f['repos/rc-international/wilco/commits/aaaaaaa']
    const r = await run(f)
    expect(r.code).toBe(1)
    expect(r.err).toContain('not found')
  })

  // WHY: the title is attacker-influenced text; it must never execute.
  test('shell metacharacters in the title are inert', async () => {
    const marker = join(dir, 'pwned')
    const r = await run(fixture(), `x $(touch ${marker}) \`touch ${marker}\` from wilco aaaaaaa`)
    expect(existsSync(marker)).toBe(false)
    expect(r.code).toBe(0)
  })

  test('maps a renamed destination (rules/ -> scripts/lib/) to its wilco source', async () => {
    const r = await run(
      fixture(
        {
          [`repos/rc-international/ci/contents/scripts/lib/terse-briefings.md?ref=${HEAD}`]: 'blob3',
          [`repos/rc-international/wilco/contents/rules/terse-briefings.md?ref=${WSHA}`]: 'blob3',
        },
        'modified scripts/lib/terse-briefings.md'
      )
    )
    expect(r.code).toBe(0)
  })
})
