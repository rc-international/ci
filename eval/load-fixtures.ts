/**
 * Pure fixture loader for the code-review eval harness.
 *
 * Side-effect-free: importing this module runs NO network, NO auto-run main(),
 * NOTHING at top level. It only defines the two pure helpers the runner
 * (eval/run.ts) needs — `loadFixtures` and `readRuns` — so they can be exercised
 * under `bun test` without dragging in run.ts's real-API main().
 *
 * `loadFixtures` FAILS LOUD on a malformed fixture: a `.diff` with no sidecar, a
 * sidecar that won't parse, or a label that fails schema validation all THROW.
 * This is intentional — a broken fixture must abort the eval, not silently vanish
 * from it and produce misleadingly-green results.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureLabel } from "./score.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_FIXTURES_DIR = join(__dirname, "fixtures");

export interface Fixture {
	name: string;
	diff: string;
	label: FixtureLabel;
}

/**
 * Validate a parsed sidecar against the FixtureLabel schema. Throws with a
 * fixture-naming message on any violation. Minimal by design: enough to catch a
 * mistyped or truncated sidecar, not a full schema library.
 */
function assertValidLabel(name: string, parsed: unknown): FixtureLabel {
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(
			`[eval] Fixture "${name}": expected.json must be a JSON object, got ${typeof parsed}.`,
		);
	}
	const obj = parsed as Record<string, unknown>;

	if (obj.class !== "should_flag" && obj.class !== "should_not_flag") {
		throw new Error(
			`[eval] Fixture "${name}": "class" must be "should_flag" or "should_not_flag", got ${JSON.stringify(obj.class)}.`,
		);
	}

	const expect = obj.expect;
	if (typeof expect !== "object" || expect === null) {
		throw new Error(
			`[eval] Fixture "${name}": "expect" must be an object.`,
		);
	}
	const flagged = (expect as Record<string, unknown>).flagged;
	if (typeof flagged !== "boolean") {
		throw new Error(
			`[eval] Fixture "${name}": "expect.flagged" must be present and boolean, got ${JSON.stringify(flagged)}.`,
		);
	}

	return parsed as FixtureLabel;
}

/**
 * Load every <name>.diff / <name>.expected.json pair from `fixturesDir`
 * (default: eval/fixtures/). Throws on a missing sidecar, unparseable JSON, or a
 * label that fails schema validation — see assertValidLabel.
 */
export function loadFixtures(fixturesDir: string = DEFAULT_FIXTURES_DIR): Fixture[] {
	const entries = readdirSync(fixturesDir)
		.filter((f) => f.endsWith(".diff"))
		.sort();

	const fixtures: Fixture[] = [];
	for (const diffFile of entries) {
		const name = diffFile.replace(/\.diff$/, "");
		const diffPath = join(fixturesDir, diffFile);
		const labelPath = join(fixturesDir, `${name}.expected.json`);

		const diff = readFileSync(diffPath, "utf8");

		// (a) missing sidecar → throw
		let rawLabel: string;
		try {
			rawLabel = readFileSync(labelPath, "utf8");
		} catch (e) {
			throw new Error(
				`[eval] Fixture "${name}": missing "${name}.expected.json" sidecar for "${diffFile}". (${e})`,
			);
		}

		// (b) unparseable JSON → throw
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawLabel);
		} catch (e) {
			throw new Error(
				`[eval] Fixture "${name}": "${name}.expected.json" is not valid JSON. (${e})`,
			);
		}

		// (c) label schema violation → throw
		const label = assertValidLabel(name, parsed);

		fixtures.push({ name, diff, label });
	}
	return fixtures;
}

/**
 * Resolve the eval-run count from EVAL_RUNS. Defaults to 5 when unset, invalid,
 * or below 1 — never returns NaN.
 */
export function readRuns(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.EVAL_RUNS;
	if (!raw) return 5;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) {
		console.warn(`[eval] EVAL_RUNS="${raw}" is invalid; defaulting to 5.`);
		return 5;
	}
	return Math.floor(n);
}
