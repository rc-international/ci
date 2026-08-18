import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "../scripts/lib/review-prompt.js";
import {
	aggregate,
	type FixtureLabel,
	type FixtureRun,
	type FixtureScore,
	isBlocking,
	scoreFixture,
} from "./score.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function finding(
	severity: ReviewFinding["severity"],
	category = "logic",
): ReviewFinding {
	return {
		file: "src/foo.ts",
		severity,
		category,
		description: "synthetic finding",
		suggested_fix: "fix it",
		line_range: "1-2",
	};
}

const shouldNotFlag: FixtureLabel = {
	class: "should_not_flag",
	description: "console carve-out",
	expect: { flagged: false },
};

function shouldFlag(
	minSeverity: "critical" | "high" | "medium",
	categoryHint?: string,
): FixtureLabel {
	return {
		class: "should_flag",
		description: "must be caught",
		expect: { flagged: true, minSeverity, categoryHint },
	};
}

function shouldFlagCalibrated(
	minSeverity: "critical" | "high" | "medium",
	expectedSeverity: ReviewFinding["severity"],
): FixtureLabel {
	return {
		class: "should_flag",
		description: "must be caught with a calibrated severity",
		expect: { flagged: true, minSeverity, expectedSeverity },
	};
}

// ── isBlocking ──────────────────────────────────────────────────────────────

describe("isBlocking", () => {
	test("high and critical block; medium/low/needs-verification do not", () => {
		expect(isBlocking(finding("critical"))).toBe(true);
		expect(isBlocking(finding("high"))).toBe(true);
		expect(isBlocking(finding("medium"))).toBe(false);
		expect(isBlocking(finding("low"))).toBe(false);
		expect(isBlocking(finding("needs-verification"))).toBe(false);
	});
});

// ── scoreFixture: should_not_flag ─────────────────────────────────────────────

describe("scoreFixture — should_not_flag", () => {
	test("a high finding is a false positive → fail", () => {
		const s = scoreFixture(shouldNotFlag, [finding("high")]);
		expect(s.pass).toBe(false);
		expect(s.blockingFindings).toBe(1);
	});

	test("a critical finding is a false positive → fail", () => {
		const s = scoreFixture(shouldNotFlag, [finding("critical")]);
		expect(s.pass).toBe(false);
		expect(s.blockingFindings).toBe(1);
	});

	test("clean (no findings) → pass", () => {
		const s = scoreFixture(shouldNotFlag, []);
		expect(s.pass).toBe(true);
		expect(s.blockingFindings).toBe(0);
	});

	test("only non-blocking findings (medium/low) → pass", () => {
		const s = scoreFixture(shouldNotFlag, [
			finding("medium"),
			finding("low"),
			finding("needs-verification"),
		]);
		expect(s.pass).toBe(true);
		expect(s.blockingFindings).toBe(0);
	});
});

// ── scoreFixture: should_flag ─────────────────────────────────────────────────

describe("scoreFixture — should_flag", () => {
	test("caught at exactly minSeverity → pass", () => {
		const s = scoreFixture(shouldFlag("high"), [finding("high")]);
		expect(s.pass).toBe(true);
	});

	test("caught above minSeverity → pass", () => {
		const s = scoreFixture(shouldFlag("medium"), [finding("critical")]);
		expect(s.pass).toBe(true);
	});

	test("caught below minSeverity → fail", () => {
		const s = scoreFixture(shouldFlag("high"), [finding("medium")]);
		expect(s.pass).toBe(false);
	});

	test("empty findings → fail", () => {
		const s = scoreFixture(shouldFlag("medium"), []);
		expect(s.pass).toBe(false);
	});

	test("needs-verification does not satisfy a medium threshold → fail", () => {
		const s = scoreFixture(shouldFlag("medium"), [
			finding("needs-verification"),
		]);
		expect(s.pass).toBe(false);
	});
});

// ── categoryHint is soft ──────────────────────────────────────────────────────

describe("scoreFixture — categoryHint is a soft signal", () => {
	test("category substring match is recorded but not required for pass", () => {
		// Right severity, WRONG category → still passes; matchedCategory false.
		const wrongCat = scoreFixture(shouldFlag("high", "security"), [
			finding("high", "performance"),
		]);
		expect(wrongCat.pass).toBe(true);
		expect(wrongCat.matchedCategory).toBe(false);

		// Right severity, matching category substring → passes; matchedCategory true.
		const rightCat = scoreFixture(shouldFlag("high", "security"), [
			finding("high", "security-injection"),
		]);
		expect(rightCat.pass).toBe(true);
		expect(rightCat.matchedCategory).toBe(true);
	});

	test("matchedCategory is false when no hint is given", () => {
		const s = scoreFixture(shouldFlag("high"), [finding("high", "security")]);
		expect(s.matchedCategory).toBe(false);
	});
});

// ── scoreFixture: severity calibration ────────────────────────────────────────

describe("scoreFixture — severity calibration", () => {
	test("exact match: bot returns expected severity → delta 0, match true", () => {
		const s = scoreFixture(shouldFlagCalibrated("high", "high"), [
			finding("high"),
		]);
		expect(s.pass).toBe(true);
		expect(s.severityDelta).toBe(0);
		expect(s.severityMatch).toBe(true);
	});

	test("over-severe: bot returns critical when expected high → delta +1", () => {
		const s = scoreFixture(shouldFlagCalibrated("high", "high"), [
			finding("critical"),
		]);
		expect(s.pass).toBe(true);
		expect(s.severityDelta).toBe(1);
		expect(s.severityMatch).toBe(false);
	});

	test("under-severe: bot's top blocking is high when expected critical → delta -1", () => {
		// expected critical, bot's highest BLOCKING finding is high (rank 3 - 4 = -1).
		const s = scoreFixture(shouldFlagCalibrated("high", "critical"), [
			finding("high"),
		]);
		expect(s.pass).toBe(true);
		expect(s.severityDelta).toBe(-1);
		expect(s.severityMatch).toBe(false);
	});

	test("highest-severity blocking finding is used when several are present", () => {
		const s = scoreFixture(shouldFlagCalibrated("high", "high"), [
			finding("high"),
			finding("critical"),
			finding("medium"),
		]);
		expect(s.severityDelta).toBe(1); // critical (4) - high (3)
		expect(s.severityMatch).toBe(false);
	});

	test("expectedSeverity unset: calibration fields stay undefined, pass unchanged", () => {
		const s = scoreFixture(shouldFlag("high"), [finding("high")]);
		expect(s.pass).toBe(true);
		expect(s.severityDelta).toBeUndefined();
		expect(s.severityMatch).toBeUndefined();
	});

	test("did-not-pass should_flag with expectedSeverity: no calibration recorded", () => {
		// Only a medium finding, minSeverity high → fails; calibration must not fire.
		const s = scoreFixture(shouldFlagCalibrated("high", "high"), [
			finding("medium"),
		]);
		expect(s.pass).toBe(false);
		expect(s.severityDelta).toBeUndefined();
		expect(s.severityMatch).toBeUndefined();
	});
});

// ── aggregate ─────────────────────────────────────────────────────────────────

function run(name: string, label: FixtureLabel, passes: boolean[]): FixtureRun {
	const scores: FixtureScore[] = passes.map((p) => ({
		pass: p,
		blockingFindings: p ? 0 : 1,
		matchedCategory: false,
	}));
	return { name, label, scores };
}

describe("aggregate", () => {
	test("false-positive rate over should_not_flag fixtures", () => {
		// fixture A: 3/5 runs failed (blocking → FP). fixture B: 0/5 failed.
		const runs: FixtureRun[] = [
			run("A", shouldNotFlag, [true, false, false, false, true]),
			run("B", shouldNotFlag, [true, true, true, true, true]),
		];
		const s = aggregate(runs);
		// 3 FP over 10 should_not_flag fixture-runs.
		expect(s.falsePositiveRate).toBeCloseTo(3 / 10);
		expect(s.recall).toBe(0); // no should_flag fixtures present
	});

	test("recall over should_flag fixtures", () => {
		const runs: FixtureRun[] = [
			run("C", shouldFlag("high"), [true, true, false, true, false]),
		];
		const s = aggregate(runs);
		// 3 caught over 5 should_flag runs.
		expect(s.recall).toBeCloseTo(3 / 5);
		expect(s.falsePositiveRate).toBe(0);
	});

	test("per-fixture verdict consistency = majority fraction", () => {
		const runs: FixtureRun[] = [
			// 4 pass / 1 fail → majority 4/5 = 0.8
			run("flip", shouldFlag("high"), [true, true, true, true, false]),
			// perfectly consistent → 1.0
			run("stable", shouldNotFlag, [true, true, true]),
		];
		const s = aggregate(runs);
		const flip = s.perFixture.find((f) => f.name === "flip");
		const stable = s.perFixture.find((f) => f.name === "stable");
		expect(flip?.consistency).toBeCloseTo(0.8);
		expect(stable?.consistency).toBe(1);
		expect(s.meanConsistency).toBeCloseTo((0.8 + 1) / 2);
	});

	test("passRate is computed per fixture", () => {
		const runs: FixtureRun[] = [
			run("half", shouldFlag("high"), [true, false, true, false]),
		];
		const s = aggregate(runs);
		expect(s.perFixture[0]?.passRate).toBeCloseTo(0.5);
		expect(s.perFixture[0]?.runs).toBe(4);
	});

	test("empty input is well-defined", () => {
		const s = aggregate([]);
		expect(s.falsePositiveRate).toBe(0);
		expect(s.recall).toBe(0);
		expect(s.meanConsistency).toBe(1);
		expect(s.perFixture).toEqual([]);
		expect(s.severityCalibration).toEqual({
			exactRate: 0,
			overSevereCount: 0,
			underSevereCount: 0,
			evaluated: 0,
		});
	});

	test("severityCalibration summarizes defined deltas; ignores undefined", () => {
		const calScore = (
			pass: boolean,
			severityDelta?: number,
		): FixtureScore => ({
			pass,
			blockingFindings: pass ? 1 : 0,
			matchedCategory: false,
			...(severityDelta === undefined
				? {}
				: { severityDelta, severityMatch: severityDelta === 0 }),
		});

		const runs: FixtureRun[] = [
			// exact, over, under → 1 exact of 3 evaluated.
			{
				name: "cal",
				label: shouldFlagCalibrated("high", "high"),
				scores: [calScore(true, 0), calScore(true, 1), calScore(true, -1)],
			},
			// should_flag WITHOUT expectedSeverity → deltas undefined, excluded.
			{
				name: "no-cal",
				label: shouldFlag("high"),
				scores: [calScore(true), calScore(true)],
			},
		];
		const s = aggregate(runs);
		expect(s.severityCalibration.evaluated).toBe(3);
		expect(s.severityCalibration.exactRate).toBeCloseTo(1 / 3);
		expect(s.severityCalibration.overSevereCount).toBe(1);
		expect(s.severityCalibration.underSevereCount).toBe(1);
	});
});
