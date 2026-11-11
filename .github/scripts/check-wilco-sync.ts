/**
 * Drift check: the review scripts in this repo are copies of rc-international/wilco main,
 * published by wilco's scripts/sync-ci.sh. A hand edit here is reverted by the next sync,
 * and a lagging copy runs an older gate than wilco's tests cover. This fails when any
 * copy differs from wilco's, and fails closed when either side cannot be read.
 *
 * Usage: bun .github/scripts/check-wilco-sync.ts <wilco-checkout> [ci-checkout=.]
 * The file list is wilco's own scripts/sync-ci.sh `publish` list (one source, no copy here).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The [path in wilco, path in ci] pairs, read from the `publish <wilco path> <ci path>` lines of
 * wilco's scripts/sync-ci.sh, so a newly published file is compared without editing this check.
 */
export function pairsFromSyncScript(text: string): [string, string][] {
	return [...text.matchAll(/^publish (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]);
}

/** One message per pair that differs or cannot be read. Empty = the copies are identical. */
export function findDrift(wilcoRoot: string, ciRoot: string): string[] {
	const syncScript = join(wilcoRoot, "scripts/sync-ci.sh");
	if (!existsSync(syncScript))
		return [
			`scripts/sync-ci.sh: missing in wilco checkout ${wilcoRoot} (cannot know what to compare)`,
		];
	const pairs = pairsFromSyncScript(readFileSync(syncScript, "utf8"));
	if (pairs.length === 0)
		return [
			"scripts/sync-ci.sh: no `publish <wilco path> <ci path>` lines found (cannot compare)",
		];
	const out: string[] = [];
	for (const [w, c] of pairs) {
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
	console.log("ci copies match wilco (every file in wilco scripts/sync-ci.sh)");
}
