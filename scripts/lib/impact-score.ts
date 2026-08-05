/**
 * PR Impact Scoring Engine
 *
 * Pure-function module that computes a 0-100 impact score for PRs across
 * four dimensions: functional impact, quality delta, risk surface, and
 * review cleanliness. No side effects, no DB access.
 *
 * Used by scripts/ci-review.ts during the CI code review pipeline.
 */

import type { ReviewFinding } from "./review-prompt";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiffStats {
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	newFiles: string[];
	deletedFiles: string[];
	modifiedFiles: string[];
}

export interface FunctionalInputs {
	commitTypes: Record<string, number>;
	newFiles: number;
	newExports: number;
	newTestFiles: number;
	hasRouteRegistration: boolean;
}

export interface QualityInputs {
	testFilesAdded: number;
	testFilesModified: number;
	deadCodeRemovedLines: number;
	emptyCatchesAdded: number;
	hardcodedValuesAdded: number;
	findingsBySeverity: Record<string, number>;
}

export interface RiskInputs {
	filesChanged: number;
	criticalPathsTouched: string[];
	newDependencies: number;
	configFilesChanged: number;
	testCoverageRatio: number;
}

export interface CleanlinessInputs {
	maxSeverity: string;
	totalFindings: number;
}

export interface ScoringInputs {
	functional: FunctionalInputs;
	quality: QualityInputs;
	risk: RiskInputs;
	cleanliness: CleanlinessInputs;
}

export interface ImpactScore {
	total: number;
	functional: number;
	quality: number;
	risk: number;
	cleanliness: number;
	inputs: ScoringInputs;
}

// ── Regex patterns ───────────────────────────────────────────────────────────

const CONVENTIONAL_COMMIT_RE =
	/^(feat|fix|refactor|perf|test|docs|chore|style|ci|build)(\(.+?\))?[!]?:/;

const EXPORT_RE =
	/^\+\s*export\s+(function|class|const|interface|type|enum|default)\b/;

const ROUTE_RE = /^\+.*\.(get|post|put|delete|patch|use)\s*\(/;

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|^tests?\//;

const EMPTY_CATCH_RE =
	/^\+.*catch\s*(\([^)]*\))?\s*\{\s*\}|^\+.*\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/;

const HARDCODED_RE =
	/^\+.*(?:https?:\/\/[^\s'"]+(?::\d+)|localhost:\d{4}|['"](?:\d{1,3}\.){3}\d{1,3}['"])/;

const DEAD_CODE_RE = /^-\s*(\/\/|import\s.*from|#\s*TODO|#\s*FIXME|\s*$)/;

const NEW_DEP_RE = /^\+\s*"[^"]+"\s*:\s*"[\^~]?\d/;

const CRITICAL_PATHS = [
	/\bauth\b/i,
	/\bsecurity\b/i,
	/\bpassword\b/i,
	/\bcredential\b/i,
	/\bpayment\b/i,
	/\bmigration\b/i,
	/\/db\//,
	/\.env/,
	/docker/i,
	/systemd/i,
	/\.service$/,
];

const CONFIG_FILES = [
	/package\.json$/,
	/tsconfig/,
	/\.yml$/,
	/\.yaml$/,
	/Dockerfile/,
	/\.toml$/,
	/\.env/,
];

// ── Signal extraction ────────────────────────────────────────────────────────

export function extractCommitTypes(
	commitMessages: string[],
): Record<string, number> {
	const types: Record<string, number> = {};
	for (const msg of commitMessages) {
		const match = msg.match(CONVENTIONAL_COMMIT_RE);
		const type = match ? match[1] : "other";
		types[type] = (types[type] || 0) + 1;
	}
	return types;
}

export function countNewExports(diffText: string): number {
	return diffText.split("\n").filter((line) => EXPORT_RE.test(line)).length;
}

export function hasRouteRegistration(diffText: string): boolean {
	return diffText.split("\n").some((line) => ROUTE_RE.test(line));
}

export function detectTestFiles(diffText: string): {
	added: number;
	modified: number;
} {
	const sections = diffText.split(/^(?=diff --git )/m);
	let added = 0;
	let modified = 0;
	for (const section of sections) {
		const pathMatch = section.match(/^diff --git a\/(.+?) b\//);
		if (!pathMatch) continue;
		const path = pathMatch[1];
		if (!TEST_FILE_RE.test(path)) continue;
		if (section.includes("new file mode")) {
			added++;
		} else {
			modified++;
		}
	}
	return { added, modified };
}

export function countEmptyCatches(diffText: string): number {
	return diffText.split("\n").filter((line) => EMPTY_CATCH_RE.test(line))
		.length;
}

export function estimateDeadCodeRemoved(diffText: string): number {
	return diffText.split("\n").filter((line) => DEAD_CODE_RE.test(line)).length;
}

export function countHardcodedValues(diffText: string): number {
	return diffText.split("\n").filter((line) => HARDCODED_RE.test(line)).length;
}

export function extractFilePaths(diffText: string): string[] {
	const re = /^diff --git a\/(.+?) b\//gm;
	const paths: string[] = [];
	let match = re.exec(diffText);
	while (match !== null) {
		paths.push(match[1]);
		match = re.exec(diffText);
	}
	return paths;
}

export function extractDiffStats(diffText: string): DiffStats {
	const sections = diffText.split(/^(?=diff --git )/m).filter(Boolean);
	const newFiles: string[] = [];
	const deletedFiles: string[] = [];
	const modifiedFiles: string[] = [];
	let linesAdded = 0;
	let linesRemoved = 0;

	for (const section of sections) {
		const pathMatch = section.match(/^diff --git a\/(.+?) b\//);
		if (!pathMatch) continue;
		const path = pathMatch[1];

		if (section.includes("new file mode")) {
			newFiles.push(path);
		} else if (section.includes("deleted file mode")) {
			deletedFiles.push(path);
		} else {
			modifiedFiles.push(path);
		}

		for (const line of section.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
			if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
		}
	}

	return {
		filesChanged: sections.length,
		linesAdded,
		linesRemoved,
		newFiles,
		deletedFiles,
		modifiedFiles,
	};
}

export function extractRiskSignals(
	diffText: string,
	allPaths: string[],
): RiskInputs {
	const criticalPaths = allPaths.filter((p) =>
		CRITICAL_PATHS.some((re) => re.test(p)),
	);
	const configFiles = allPaths.filter((p) =>
		CONFIG_FILES.some((re) => re.test(p)),
	);
	const testFiles = allPaths.filter((p) => TEST_FILE_RE.test(p));

	// Count new dependencies from package.json hunks
	const pkgSections = diffText
		.split(/^(?=diff --git )/m)
		.filter((s) => s.includes("package.json"));
	let newDeps = 0;
	for (const section of pkgSections) {
		newDeps += section.split("\n").filter((l) => NEW_DEP_RE.test(l)).length;
	}

	return {
		filesChanged: allPaths.length,
		criticalPathsTouched: [...new Set(criticalPaths)],
		newDependencies: newDeps,
		configFilesChanged: configFiles.length,
		testCoverageRatio:
			allPaths.length > 0 ? testFiles.length / allPaths.length : 0,
	};
}

// ── Dimension scorers ────────────────────────────────────────────────────────

const TYPE_SCORES: Record<string, number> = {
	feat: 15,
	fix: 12,
	refactor: 10,
	perf: 10,
	test: 8,
	docs: 5,
	chore: 3,
	style: 2,
	ci: 3,
	build: 3,
};

export function scoreFunctional(inputs: FunctionalInputs): number {
	let score = 0;

	// Base score from commit type (highest type wins)
	let maxTypeScore = 0;
	for (const [type, _count] of Object.entries(inputs.commitTypes)) {
		const typeScore = TYPE_SCORES[type] || 5;
		if (typeScore > maxTypeScore) maxTypeScore = typeScore;
	}
	score += maxTypeScore;

	// Bonus for new non-test files (capped)
	const nonTestNewFiles = inputs.newFiles - inputs.newTestFiles;
	if (nonTestNewFiles > 0) {
		score += Math.min(nonTestNewFiles * 2, 6);
	}

	// Bonus for new exports (new public API surface)
	if (inputs.newExports > 0) {
		score += Math.min(inputs.newExports, 4);
	}

	// Bonus for route registration
	if (inputs.hasRouteRegistration) {
		score += 3;
	}

	// Bonus for accompanying test files
	if (inputs.newTestFiles > 0) {
		score += 2;
	}

	return Math.min(score, 30);
}

const FINDING_PENALTIES: Record<string, number> = {
	critical: 5,
	high: 3,
	medium: 1,
	low: 0,
	"needs-verification": 0,
};

export function scoreQuality(inputs: QualityInputs): number {
	let score = 15;

	// Positive signals
	if (inputs.testFilesAdded > 0) {
		score += Math.min(inputs.testFilesAdded * 3, 6);
	}
	if (inputs.testFilesModified > 0) {
		score += Math.min(inputs.testFilesModified * 1, 3);
	}
	if (inputs.deadCodeRemovedLines > 10) {
		score += Math.min(Math.floor(inputs.deadCodeRemovedLines / 10), 3);
	}

	// Negative signals from diff analysis
	if (inputs.emptyCatchesAdded > 0) {
		score -= inputs.emptyCatchesAdded * 3;
	}
	if (inputs.hardcodedValuesAdded > 0) {
		score -= Math.min(inputs.hardcodedValuesAdded * 1, 4);
	}

	// Negative signals from review findings
	for (const [severity, count] of Object.entries(inputs.findingsBySeverity)) {
		score -= (FINDING_PENALTIES[severity] || 0) * count;
	}

	return Math.max(0, Math.min(score, 30));
}

export function scoreRisk(inputs: RiskInputs): number {
	let score = 20;

	// File count penalty
	if (inputs.filesChanged > 10) {
		score -= 6;
	} else if (inputs.filesChanged > 5) {
		score -= 3;
	} else if (inputs.filesChanged > 3) {
		score -= 1;
	}

	// Critical paths penalty
	if (inputs.criticalPathsTouched.length > 0) {
		score -= Math.min(inputs.criticalPathsTouched.length * 2, 6);
	}

	// New dependencies penalty
	if (inputs.newDependencies > 0) {
		score -= Math.min(inputs.newDependencies * 2, 4);
	}

	// Config file changes penalty
	if (inputs.configFilesChanged > 0) {
		score -= Math.min(inputs.configFilesChanged, 3);
	}

	// Test coverage ratio bonus
	if (inputs.testCoverageRatio >= 0.3) {
		score += 2;
	}

	return Math.max(0, Math.min(score, 20));
}

const SEVERITY_SCORES: Record<string, number> = {
	low: 15,
	"needs-verification": 15,
	medium: 10,
	high: 5,
	critical: 0,
};

export function scoreCleanliness(inputs: CleanlinessInputs): number {
	if (inputs.totalFindings === 0) return 20;

	const base = SEVERITY_SCORES[inputs.maxSeverity] ?? 10;
	const volumePenalty = Math.min(Math.floor(inputs.totalFindings / 3), 5);

	return Math.max(0, base - volumePenalty);
}

// ── Composite scorer ─────────────────────────────────────────────────────────

export function computeImpactScore(
	diffText: string,
	commitMessages: string[],
	findings: ReviewFinding[],
): ImpactScore {
	const allPaths = extractFilePaths(diffText);
	const diffStats = extractDiffStats(diffText);
	const testFiles = detectTestFiles(diffText);
	const commitTypes = extractCommitTypes(commitMessages);

	// Build inputs
	const functionalInputs: FunctionalInputs = {
		commitTypes,
		newFiles: diffStats.newFiles.length,
		newExports: countNewExports(diffText),
		newTestFiles: testFiles.added,
		hasRouteRegistration: hasRouteRegistration(diffText),
	};

	const findingsBySeverity: Record<string, number> = {};
	let maxSeverity = "";
	const severityRank: Record<string, number> = {
		critical: 4,
		high: 3,
		medium: 2,
		low: 1,
		"needs-verification": 0,
	};
	let maxRank = -1;
	for (const f of findings) {
		findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
		const rank = severityRank[f.severity] ?? 0;
		if (rank > maxRank) {
			maxRank = rank;
			maxSeverity = f.severity;
		}
	}

	const qualityInputs: QualityInputs = {
		testFilesAdded: testFiles.added,
		testFilesModified: testFiles.modified,
		deadCodeRemovedLines: estimateDeadCodeRemoved(diffText),
		emptyCatchesAdded: countEmptyCatches(diffText),
		hardcodedValuesAdded: countHardcodedValues(diffText),
		findingsBySeverity,
	};

	const riskInputs = extractRiskSignals(diffText, allPaths);

	const cleanlinessInputs: CleanlinessInputs = {
		maxSeverity: maxSeverity || "none",
		totalFindings: findings.length,
	};

	// Compute dimension scores
	const functional = scoreFunctional(functionalInputs);
	const quality = scoreQuality(qualityInputs);
	const risk = scoreRisk(riskInputs);
	const cleanliness = scoreCleanliness(cleanlinessInputs);

	return {
		total: functional + quality + risk + cleanliness,
		functional,
		quality,
		risk,
		cleanliness,
		inputs: {
			functional: functionalInputs,
			quality: qualityInputs,
			risk: riskInputs,
			cleanliness: cleanlinessInputs,
		},
	};
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatImpactScore(score: ImpactScore): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push("");
	lines.push(`## PR Impact Score: ${score.total}/100`);
	lines.push("");
	lines.push("| Dimension | Score | Max | |");
	lines.push("|-----------|------:|----:|---|");

	// Functional summary
	const topType =
		Object.entries(score.inputs.functional.commitTypes).sort(
			(a, b) => b[1] - a[1],
		)[0]?.[0] || "unknown";
	const funcDetail =
		score.inputs.functional.newFiles > 0
			? `New ${topType} with ${score.inputs.functional.newFiles} new file(s)`
			: `${topType} change`;
	lines.push(
		`| Functional Impact | ${score.functional} | 30 | ${funcDetail} |`,
	);

	// Quality summary
	const totalFindings = Object.values(
		score.inputs.quality.findingsBySeverity,
	).reduce((a, b) => a + b, 0);
	const qualParts: string[] = [];
	if (score.inputs.quality.testFilesAdded > 0) qualParts.push("Tests added");
	if (score.inputs.quality.deadCodeRemovedLines > 10)
		qualParts.push("Dead code removed");
	if (totalFindings > 0) qualParts.push(`${totalFindings} finding(s)`);
	if (qualParts.length === 0) qualParts.push("Clean");
	lines.push(
		`| Quality Delta | ${score.quality} | 30 | ${qualParts.join(", ")} |`,
	);

	// Risk summary
	const riskParts: string[] = [`${score.inputs.risk.filesChanged} files`];
	if (score.inputs.risk.criticalPathsTouched.length > 0) {
		riskParts.push(
			`${score.inputs.risk.criticalPathsTouched.length} critical path(s)`,
		);
	}
	if (score.inputs.risk.newDependencies > 0) {
		riskParts.push(`${score.inputs.risk.newDependencies} new dep(s)`);
	}
	lines.push(`| Risk Surface | ${score.risk} | 20 | ${riskParts.join(", ")} |`);

	// Cleanliness summary
	const cleanDesc =
		score.inputs.cleanliness.totalFindings === 0
			? "No findings"
			: `${score.inputs.cleanliness.maxSeverity}-severity findings`;
	lines.push(
		`| Review Cleanliness | ${score.cleanliness} | 20 | ${cleanDesc} |`,
	);

	lines.push(`| **Total** | **${score.total}** | **100** | |`);

	return lines.join("\n");
}
