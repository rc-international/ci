/**
 * Workflow wiring for the org outcome registry (plan 2026-11-11-business-outcome-tracking-20).
 *
 * WHY: ci-review.ts only sees outcomes/org.yaml if the reusable code-review workflow checks
 * out outcomes/ and sets CI_ORG_OUTCOMES_REQUIRED=1 (a missing file is then a finding, not a
 * silent skip). Drop either line and every consuming repo loses the org id check with no
 * failure. The drift and test workflows are pinned the same way. Parsed with the `yaml`
 * package, like the production loader.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
type Workflow = {
	on: Record<string, unknown>;
	jobs: Record<string, { steps: Step[] }>;
};

const load = (name: string): Workflow =>
	parse(
		readFileSync(join(import.meta.dir, "../workflows", name), "utf8"),
	) as Workflow;
const steps = (w: Workflow): Step[] =>
	Object.values(w.jobs).flatMap((j) => j.steps);

describe("code-review.yml feeds the gate the org registry", () => {
	const all = steps(load("code-review.yml"));

	test("the review step sets CI_ORG_OUTCOMES_REQUIRED=1", () => {
		const review = all.find((s) => s.run === "bun .ci/scripts/ci-review.ts");
		expect(review?.env?.CI_ORG_OUTCOMES_REQUIRED).toBe("1");
	});

	test("the ci checkout that holds ci-review.ts also carries outcomes/", () => {
		const co = all.find(
			(s) =>
				s.with?.repository === "rc-international/ci" && s.with?.path === ".ci",
		);
		expect(String(co?.with?.["sparse-checkout"])).toContain("outcomes/");
		expect(String(co?.with?.["sparse-checkout"])).toContain(
			"scripts/ci-review.ts",
		);
	});
});

describe("wilco-sync-check.yml", () => {
	const wf = load("wilco-sync-check.yml");
	const all = steps(wf);

	test("the wilco checkout does not persist credentials", () => {
		const co = all.find((s) => s.with?.repository === "rc-international/wilco");
		expect(co?.with?.["persist-credentials"]).toBe(false);
	});

	test("the app token is read-only", () => {
		const tok = all.find((s) =>
			s.uses?.startsWith("actions/create-github-app-token"),
		);
		expect(tok?.with?.["permission-contents"]).toBe("read");
		expect(tok?.with?.repositories).toBe("wilco");
	});

	test("it runs weekly as well as on PRs, so lag between wilco and ci shows up", () => {
		expect(wf.on.schedule).toBeDefined();
		expect(wf.on.pull_request).toBeDefined();
	});
});

describe("org-outcomes-tests.yml", () => {
	const wf = load("org-outcomes-tests.yml");

	test("runs on PRs touching the registry or the synced gate scripts", () => {
		const paths = (wf.on.pull_request as { paths: string[] }).paths;
		for (const p of [
			"outcomes/**",
			"scripts/ci-review.ts",
			"scripts/lib/**",
			".github/workflows/code-review.yml",
		])
			expect(paths).toContain(p);
	});

	test("runs the org registry and wiring tests", () => {
		const run = steps(wf)
			.map((s) => s.run ?? "")
			.join("\n");
		expect(run).toContain("org-outcomes.test.ts");
		expect(run).toContain("code-review-wiring.test.ts");
	});
});
