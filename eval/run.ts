/**
 * Eval runner — scores a configured review model against labeled fixture diffs.
 *
 * Runs the REAL review pipeline (callReviewModel from ci-review.ts) against every
 * eval/fixtures/<name>.diff N times (default 5, override with EVAL_RUNS), scores
 * each run with the pure scorer (eval/score.ts), and prints a per-fixture table
 * plus an aggregate summary: false-positive rate, recall, and verdict
 * consistency.
 *
 * THIS HITS A REAL API and costs tokens + is non-deterministic. It must NEVER run
 * under `bun test` — the filename deliberately omits `.test.` so bun's test
 * discovery skips it. Run explicitly:
 *
 *   CI_REVIEW_MODEL=openai/gpt-oss-120b \
 *   CODE_REVIEW_GROQ_API_KEY=... \
 *   bun eval/run.ts
 *
 * Model/endpoint/effort come from the SAME env vars the bot reads
 * (CI_REVIEW_MODEL, CI_REVIEW_ENDPOINT, CI_REVIEW_REASONING_EFFORT). The API key
 * comes from CODE_REVIEW_GROQ_API_KEY (or GROQ_API_KEY). Nothing is hardcoded.
 */

// Suppress ci-review.ts's module-level main() auto-run on import. We only want
// its exported callReviewModel; main() would try to run a real PR review.
// NOTE: this MUST be set before ci-review.ts is evaluated. Static ES imports are
// hoisted above top-level statements, so ci-review.ts is imported DYNAMICALLY
// inside main() (after this assignment has run) rather than at the top.
process.env.__CI_REVIEW_TEST ||= "1";

import type { ReviewFinding } from "../scripts/lib/review-prompt.js";
import { loadFixtures, readRuns } from "./load-fixtures.js";
import {
	aggregate,
	type FixtureRun,
	type FixtureScore,
	scoreFixture,
} from "./score.js";

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function pct(x: number): string {
	return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
	const apiKey =
		process.env.CODE_REVIEW_GROQ_API_KEY || process.env.GROQ_API_KEY;
	if (!apiKey) {
		console.error(
			"[eval] No API key. Set CODE_REVIEW_GROQ_API_KEY (or GROQ_API_KEY) before running eval/run.ts.",
		);
		process.exit(1);
	}

	// Dynamic import (see top-of-file note): loading ci-review.ts evaluates its
	// module body, which auto-runs main() unless __CI_REVIEW_TEST is set. That env
	// var is assigned at the top of THIS file, before this import runs.
	const { callReviewModel } = await import("../scripts/ci-review.js");

	const runs = readRuns();
	const model = process.env.CI_REVIEW_MODEL || "openai/gpt-oss-120b";
	const endpoint =
		process.env.CI_REVIEW_ENDPOINT || "(bot default Groq endpoint)";
	const fixtures = loadFixtures();

	if (fixtures.length === 0) {
		console.error(`[eval] No fixtures found in eval/fixtures.`);
		process.exit(1);
	}

	console.log(
		`[eval] model=${model} endpoint=${endpoint} runs=${runs} fixtures=${fixtures.length}`,
	);

	const fixtureRuns: FixtureRun[] = [];
	let totalFindings = 0;

	for (const fx of fixtures) {
		const scores: FixtureScore[] = [];
		let fxFindings = 0;
		let apiErrors = 0;

		for (let i = 0; i < runs; i++) {
			// fileContext / prBody are not needed to exercise the reviewer on a raw
			// diff; the bot supplies them in production but the diff alone is a
			// faithful, cheaper eval input.
			const result = await callReviewModel(apiKey, fx.diff, "", "");
			if (result.apiError) {
				apiErrors += 1;
				console.warn(
					`[eval] ${fx.name} run ${i + 1}/${runs}: API error (${result.errorKind ?? "unknown"}) — counted as no-findings.`,
				);
			}
			const findings: ReviewFinding[] = result.findings ?? [];
			fxFindings += findings.length;
			scores.push(scoreFixture(fx.label, findings));
		}

		totalFindings += fxFindings;
		fixtureRuns.push({ name: fx.name, label: fx.label, scores });

		if (apiErrors > 0) {
			console.warn(
				`[eval] ${fx.name}: ${apiErrors}/${runs} runs hit an API error — scores for those runs may understate flagging.`,
			);
		}
	}

	const summary = aggregate(fixtureRuns);

	// ── Per-fixture table ──────────────────────────────────────────────────────
	console.log("\nPer-fixture results:");
	console.log(
		`  ${pad("fixture", 26)} ${pad("class", 16)} ${pad("pass", 6)} ${pad("consistency", 12)}`,
	);
	for (const f of summary.perFixture) {
		console.log(
			`  ${pad(f.name, 26)} ${pad(f.class, 16)} ${pad(pct(f.passRate), 6)} ${pad(pct(f.consistency), 12)}`,
		);
	}

	// ── Aggregate summary ──────────────────────────────────────────────────────
	console.log("\nAggregate:");
	console.log(
		`  false-positive rate (should_not_flag): ${pct(summary.falsePositiveRate)}`,
	);
	console.log(
		`  recall (should_flag):                   ${pct(summary.recall)}`,
	);
	console.log(
		`  mean verdict consistency:               ${pct(summary.meanConsistency)}`,
	);
	console.log(`  total findings across all runs:         ${totalFindings}`);
}

main().catch((err) => {
	console.error("[eval] Fatal error:", err);
	process.exit(1);
});
