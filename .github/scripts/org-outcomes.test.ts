/**
 * Tests for outcomes/org.yaml, the owner's 20 business outcomes (plan
 * 2026-11-11-business-outcome-tracking-20, C1).
 *
 * WHY: the PR outcome gate accepts exactly the ids in this file. A duplicate, a typo'd
 * type, an unmeasured outcome with no named blocker, or a dropped entry would either flag
 * valid PRs or let the tracker report a number for an outcome that has no source. The loader
 * (scripts/lib/org-outcomes.ts) already rejects a malformed file at review time; this test
 * rejects it at merge time and pins the count.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
	loadOrgOutcomeIds,
	validateOrgOutcomes,
} from "../../scripts/lib/org-outcomes";

const FILE = join(import.meta.dir, "../../outcomes/org.yaml");
const doc = parse(readFileSync(FILE, "utf8")) as {
	outcomes: Record<string, unknown>[];
};

// Parsed with the `yaml` package, the same parser the review gate uses in production, so a
// file that Bun's YAML accepts but `yaml` rejects (or reads differently) cannot pass here.
describe("outcomes/org.yaml", () => {
	test("loads through the production loader: 21 ids, no error", async () => {
		const out = await loadOrgOutcomeIds(FILE, { required: true });
		expect(out.error).toBeUndefined();
		expect(out.ids?.size).toBe(21);
	});

	test("passes the loader schema (types, measure or blocker, unique oNN ids)", () => {
		expect(validateOrgOutcomes(doc).problems).toEqual([]);
	});

	// o01..o20: owner list 2026-11-11. o21: owner session outcome 2026-11-13.
	test("has exactly the owner's 21 outcomes, o01..o21 in order", () => {
		expect(doc.outcomes).toHaveLength(21);
		doc.outcomes.forEach((o, i) => {
			expect(String(o.id).slice(0, 3)).toBe(
				`o${String(i + 1).padStart(2, "0")}`,
			);
		});
	});

	test("week 1 holds o01..o10 and week 2 holds o11..o20 (owner list 2026-11-11)", () => {
		doc.outcomes.slice(0, 20).forEach((o, i) => {
			expect(o.week).toBe(i < 10 ? 1 : 2);
		});
		// o21 (owner 2026-11-13) is the standing session-outcome accountability outcome, started in week 1.
		expect(doc.outcomes[20]?.week).toBe(1);
	});

	test("every target is still marked as an estimate, not our data", () => {
		for (const o of doc.outcomes) expect(o.target_source).toBe("estimate");
	});

	test("unmeasured outcomes name their blocker (never a silent zero)", () => {
		const unmeasured = doc.outcomes.filter((o) => o.type === "unmeasured");
		expect(unmeasured.length).toBeGreaterThan(0);
		for (const o of unmeasured)
			expect(String(o.blocker).length).toBeGreaterThan(10);
	});

	test("the loader rejects a mutated copy: a dropped blocker, a duplicate id, a bad type", () => {
		const problems = (f: (o: Record<string, unknown>[]) => void) => {
			const c = structuredClone(doc);
			f(c.outcomes);
			return validateOrgOutcomes(c).problems.length;
		};
		expect(problems((o) => delete o[2].blocker)).toBeGreaterThan(0); // o03 is unmeasured
		expect(problems((o) => (o[1].id = o[0].id))).toBeGreaterThan(0);
		expect(problems((o) => (o[0].type = "vibes"))).toBeGreaterThan(0);
	});
});
