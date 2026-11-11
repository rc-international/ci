/**
 * Drift check: the review scripts in this repo are copies of rc-international/wilco main,
 * published by wilco's scripts/sync-ci.sh. A hand edit here is reverted by the next sync,
 * and a lagging copy runs an older gate than wilco's tests cover. This fails when any
 * copy differs from wilco's, and fails closed when either side cannot be read.
 *
 * Usage: bun .github/scripts/check-wilco-sync.ts <wilco-checkout> [ci-checkout=.]
 * Keep PAIRS equal to the `publish` lines of wilco scripts/sync-ci.sh.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** [path in wilco, path in ci] */
export const PAIRS: readonly (readonly [string, string])[] = [
	["scripts/ci-review.ts", "scripts/ci-review.ts"],
	["scripts/lib/review-prompt.ts", "scripts/lib/review-prompt.ts"],
	["scripts/lib/impact-score.ts", "scripts/lib/impact-score.ts"],
	["scripts/lib/stream-chat.ts", "scripts/lib/stream-chat.ts"],
	["scripts/lib/commit-author-guard.ts", "scripts/lib/commit-author-guard.ts"],
	[
		"scripts/lib/ci-review-determinism.ts",
		"scripts/lib/ci-review-determinism.ts",
	],
	["scripts/lib/outcome-lines.ts", "scripts/lib/outcome-lines.ts"],
	["scripts/lib/org-outcomes.ts", "scripts/lib/org-outcomes.ts"],
	["rules/terse-briefings.md", "scripts/lib/terse-briefings.md"],
];

/** One message per pair that differs or cannot be read. Empty = the copies are identical. */
export function findDrift(wilcoRoot: string, ciRoot: string): string[] {
	const out: string[] = [];
	for (const [w, c] of PAIRS) {
		const wf = join(wilcoRoot, w);
		const cf = join(ciRoot, c);
		if (!existsSync(wf)) {
			out.push(`${w}: missing in wilco checkout ${wilcoRoot} (cannot compare)`);
			continue;
		}
		if (!existsSync(cf)) {
			out.push(`${c}: missing in ci checkout ${ciRoot}`);
			continue;
		}
		const a = readFileSync(wf, "utf8");
		const b = readFileSync(cf, "utf8");
		if (a === b) continue;
		const al = a.split("\n");
		const bl = b.split("\n");
		let n = 0;
		while (n < Math.max(al.length, bl.length) && al[n] === bl[n]) n++;
		out.push(`${c}: differs from wilco ${w} at line ${n + 1}`);
	}
	return out;
}

if (import.meta.main) {
	const [wilco, ci = "."] = process.argv.slice(2);
	if (!wilco) {
		console.error("usage: check-wilco-sync.ts <wilco-checkout> [ci-checkout]");
		process.exit(2);
	}
	const drift = findDrift(wilco, ci);
	for (const d of drift) console.error(`DRIFT ${d}`);
	if (drift.length > 0) {
		console.error(
			"Edit these files in wilco (source of truth); scripts/sync-ci.sh publishes them here.",
		);
		process.exit(1);
	}
	console.log(`ci copies match wilco (${PAIRS.length} files)`);
}
