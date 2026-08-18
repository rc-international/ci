/**
 * Pure quality scorer for the code-review eval harness.
 *
 * Given a fixture's expected label and the array of findings the model returned
 * for that fixture, decide pass/fail — with NO network and NO LLM. This is the
 * only part of the eval covered by `bun test`; the runner (eval/run.ts) hits a
 * real API and must never run under the test runner.
 *
 * Two verdict rules mirror how the bot itself blocks a PR:
 * - A finding of severity `critical` or `high` is BLOCKING (drives
 *   REQUEST_CHANGES in the real pipeline). For a `should_not_flag` fixture, any
 *   blocking finding is a FALSE POSITIVE.
 * - For a `should_flag` fixture, we require at least one finding at or above the
 *   fixture's `minSeverity`. `categoryHint` is a SOFT signal — recorded, never
 *   required for pass.
 */

import type { ReviewFinding } from "../scripts/lib/review-prompt.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type FixtureClass = "should_flag" | "should_not_flag";

export type Severity =
	| "critical"
	| "high"
	| "medium"
	| "low"
	| "needs-verification";

export interface FixtureExpectation {
	flagged: boolean;
	minSeverity?: "critical" | "high" | "medium";
	categoryHint?: string;
}

export interface FixtureLabel {
	class: FixtureClass;
	description: string;
	expect: FixtureExpectation;
}

export interface FixtureScore {
	pass: boolean;
	blockingFindings: number;
	matchedCategory: boolean;
}

// ── Severity ordering ─────────────────────────────────────────────────────────

// Higher number = more severe. `needs-verification` sits at the bottom with
// `low`: it never blocks and never satisfies a `should_flag` minSeverity of
// medium+, matching the bot's "any critical/high ⇒ REQUEST_CHANGES" verdict.
const SEVERITY_RANK: Record<Severity, number> = {
	"needs-verification": 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

function severityRank(severity: string): number {
	// Unknown/garbage severities rank below everything so they never block and
	// never satisfy a should_flag threshold — a malformed finding is not evidence.
	return SEVERITY_RANK[severity as Severity] ?? -1;
}

const BLOCKING_RANK = SEVERITY_RANK.high;

/** A blocking finding is severity `high` or `critical` — same as the bot verdict. */
export function isBlocking(finding: ReviewFinding): boolean {
	return severityRank(finding.severity) >= BLOCKING_RANK;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

/**
 * Score a single fixture's findings against its expected label.
 *
 * `matchedCategory` is a soft diagnostic only: it records whether any finding's
 * category substring-matches the (optional) `categoryHint`. It never affects
 * `pass`.
 */
export function scoreFixture(
	label: FixtureLabel,
	findings: ReviewFinding[],
): FixtureScore {
	const blockingFindings = findings.filter(isBlocking).length;

	const hint = label.expect.categoryHint?.toLowerCase();
	const matchedCategory = hint
		? findings.some((f) => (f.category || "").toLowerCase().includes(hint))
		: false;

	let pass: boolean;
	if (label.class === "should_not_flag") {
		// PASS iff NO blocking finding — a blocking finding here is a false positive.
		pass = blockingFindings === 0;
	} else {
		// should_flag: PASS iff at least one finding meets the min severity bar.
		const min = severityRank(label.expect.minSeverity ?? "medium");
		pass = findings.some((f) => severityRank(f.severity) >= min);
	}

	return { pass, blockingFindings, matchedCategory };
}

// ── Aggregation ────────────────────────────────────────────────────────────────

export interface FixtureRun {
	/** Fixture name (stable key across runs). */
	name: string;
	label: FixtureLabel;
	/** Per-run scores for THIS fixture, one entry per eval run. */
	scores: FixtureScore[];
}

export interface FixtureAggregate {
	name: string;
	class: FixtureClass;
	/** Fraction of runs that passed. */
	passRate: number;
	/**
	 * Verdict consistency: fraction of runs whose pass/fail matched the fixture's
	 * MAJORITY verdict across all runs. 1.0 means every run agreed. A model that
	 * flips APPROVED/CHANGES_REQUESTED run-to-run scores below 1.0 here.
	 */
	consistency: number;
	runs: number;
}

export interface AggregateSummary {
	/** False-positive rate over `should_not_flag` fixtures: fraction of those
	 *  fixture-runs that (wrongly) produced a blocking finding. */
	falsePositiveRate: number;
	/** Recall over `should_flag` fixtures: fraction of those fixture-runs that
	 *  caught the issue at/above minSeverity. */
	recall: number;
	/** Mean per-fixture verdict consistency across all fixtures. */
	meanConsistency: number;
	perFixture: FixtureAggregate[];
}

/** Fraction of the runs whose boolean pass matched the majority pass value. */
function verdictConsistency(scores: FixtureScore[]): number {
	if (scores.length === 0) return 1;
	const passes = scores.filter((s) => s.pass).length;
	const fails = scores.length - passes;
	const majorityCount = Math.max(passes, fails);
	return majorityCount / scores.length;
}

/**
 * Aggregate per-fixture results across N runs into headline metrics. Pure over
 * the in-memory array — no I/O.
 */
export function aggregate(runs: FixtureRun[]): AggregateSummary {
	const perFixture: FixtureAggregate[] = runs.map((r) => {
		const total = r.scores.length;
		const passes = r.scores.filter((s) => s.pass).length;
		return {
			name: r.name,
			class: r.label.class,
			passRate: total === 0 ? 0 : passes / total,
			consistency: verdictConsistency(r.scores),
			runs: total,
		};
	});

	// False-positive rate: over should_not_flag fixture-runs, the share that
	// produced a blocking finding (i.e. failed).
	let fpFail = 0;
	let fpTotal = 0;
	// Recall: over should_flag fixture-runs, the share that passed (caught it).
	let recallPass = 0;
	let recallTotal = 0;

	for (const r of runs) {
		for (const s of r.scores) {
			if (r.label.class === "should_not_flag") {
				fpTotal += 1;
				if (!s.pass) fpFail += 1;
			} else {
				recallTotal += 1;
				if (s.pass) recallPass += 1;
			}
		}
	}

	const meanConsistency =
		perFixture.length === 0
			? 1
			: perFixture.reduce((acc, f) => acc + f.consistency, 0) /
				perFixture.length;

	return {
		falsePositiveRate: fpTotal === 0 ? 0 : fpFail / fpTotal,
		recall: recallTotal === 0 ? 0 : recallPass / recallTotal,
		meanConsistency,
		perFixture,
	};
}
