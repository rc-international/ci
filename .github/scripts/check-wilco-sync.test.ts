/**
 * WHY: the review gate in this repo is a copy of wilco's. The check must catch a one-character
 * difference (a hand edit or a lagging sync), must not pass when a side is unreadable, and must
 * follow wilco's own publish list so a newly published file cannot be missed.
 */
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findDrift, pairsFromSyncScript } from "./check-wilco-sync";

// Same shape as the `publish` lines of wilco scripts/sync-ci.sh, including the `publish()`
// definition line and a comment that must not be read as a pair.
const SYNC_SCRIPT = `#!/usr/bin/env bash
# publish <wilco path> <ci path>: copy the committed version.
publish() { git -C "$WILCO_DIR" show "$SRC_REF:$1" > "$CI_REPO_DIR/$2"; }

publish scripts/ci-review.ts scripts/ci-review.ts
publish scripts/lib/outcome-lines.ts scripts/lib/outcome-lines.ts
publish rules/terse-briefings.md scripts/lib/terse-briefings.md
`;
const PAIRS = [
	["scripts/ci-review.ts", "scripts/ci-review.ts"],
	["scripts/lib/outcome-lines.ts", "scripts/lib/outcome-lines.ts"],
	["rules/terse-briefings.md", "scripts/lib/terse-briefings.md"],
] as const;

function write(root: string, rel: string, text: string) {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
}

function tree(syncScript = SYNC_SCRIPT): { wilco: string; ci: string } {
	const root = mkdtempSync(join(tmpdir(), "wilco-sync-"));
	const wilco = join(root, "wilco");
	const ci = join(root, "ci");
	write(wilco, "scripts/sync-ci.sh", syncScript);
	for (const [w, c] of PAIRS) {
		write(wilco, w, `// ${w}\nexport const x = 1\n`);
		write(ci, c, `// ${w}\nexport const x = 1\n`);
	}
	return { wilco, ci };
}

describe("pairsFromSyncScript", () => {
	test("reads the publish lines, not the function definition or comments", () => {
		expect(pairsFromSyncScript(SYNC_SCRIPT)).toEqual(
			PAIRS.map(([a, b]) => [a, b]),
		);
	});
});

describe("findDrift", () => {
	test("identical copies: no drift", () => {
		const { wilco, ci } = tree();
		expect(findDrift(wilco, ci)).toEqual([]);
	});

	test("a one-character difference is reported with its line", () => {
		const { wilco, ci } = tree();
		const f = join(ci, "scripts/lib/outcome-lines.ts");
		writeFileSync(f, readFileSync(f, "utf8").replace("x = 1", "x = 2"));
		const drift = findDrift(wilco, ci);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toContain("scripts/lib/outcome-lines.ts");
		expect(drift[0]).toContain("line 2");
	});

	test("a trailing-newline difference is drift too", () => {
		const { wilco, ci } = tree();
		const f = join(ci, "scripts/ci-review.ts");
		writeFileSync(f, `${readFileSync(f, "utf8")}\n`);
		expect(findDrift(wilco, ci)).toHaveLength(1);
	});

	test("a file missing on either side fails closed", () => {
		const { wilco, ci } = tree();
		rmSync(join(ci, "scripts/ci-review.ts"));
		rmSync(join(wilco, "scripts/lib/outcome-lines.ts"));
		const drift = findDrift(wilco, ci);
		expect(
			drift.some((d) => d.includes("ci-review.ts") && d.includes("missing")),
		).toBe(true);
		expect(
			drift.some(
				(d) => d.includes("outcome-lines.ts") && d.includes("missing"),
			),
		).toBe(true);
	});

	test("a file newly added to wilco's publish list is compared without editing this check", () => {
		const { wilco, ci } = tree(
			`${SYNC_SCRIPT}publish scripts/lib/new-lib.ts scripts/lib/new-lib.ts\n`,
		);
		write(wilco, "scripts/lib/new-lib.ts", "a\n");
		write(ci, "scripts/lib/new-lib.ts", "b\n");
		const drift = findDrift(wilco, ci);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toContain("new-lib.ts");
	});

	test("no sync-ci.sh, or one with no publish lines, fails closed", () => {
		const { wilco, ci } = tree();
		rmSync(join(wilco, "scripts/sync-ci.sh"));
		expect(findDrift(wilco, ci)[0]).toContain("sync-ci.sh");
		write(wilco, "scripts/sync-ci.sh", "#!/usr/bin/env bash\necho hi\n");
		expect(findDrift(wilco, ci)[0]).toContain("no `publish");
	});
});
