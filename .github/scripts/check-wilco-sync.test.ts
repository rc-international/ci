/**
 * WHY: the review gate in this repo is a copy of wilco's. The check must catch a one-character
 * difference (a hand edit or a lagging sync) and must not pass when a side is unreadable.
 */
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findDrift, PAIRS } from "./check-wilco-sync";

const REPO = join(import.meta.dir, "../..");

function tree(): { wilco: string; ci: string } {
	const root = mkdtempSync(join(tmpdir(), "wilco-sync-"));
	const wilco = join(root, "wilco");
	const ci = join(root, "ci");
	for (const [w, c] of PAIRS) {
		for (const [dir, rel] of [
			[wilco, w],
			[ci, c],
		] as const) {
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			writeFileSync(join(dir, rel), `// ${w}\nexport const x = 1\n`);
		}
	}
	return { wilco, ci };
}

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
		rmSync(join(ci, "scripts/lib/stream-chat.ts"));
		rmSync(join(wilco, "scripts/lib/impact-score.ts"));
		const drift = findDrift(wilco, ci);
		expect(
			drift.some((d) => d.includes("stream-chat.ts") && d.includes("missing")),
		).toBe(true);
		expect(
			drift.some((d) => d.includes("impact-score.ts") && d.includes("missing")),
		).toBe(true);
	});

	test("every ci path in PAIRS exists in this repo", () => {
		// A renamed or removed copy must not silently drop out of the check.
		for (const [, c] of PAIRS) expect(existsSync(join(REPO, c))).toBe(true);
	});
});
