import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtures, readRuns } from "./load-fixtures.js";

// ── Temp-dir fixture scaffolding ──────────────────────────────────────────────

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "eval-fixtures-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeDiff(name: string, contents = "--- a\n+++ b\n"): void {
	writeFileSync(join(dir, `${name}.diff`), contents);
}

function writeSidecar(name: string, raw: string): void {
	writeFileSync(join(dir, `${name}.expected.json`), raw);
}

const validLabel = JSON.stringify({
	class: "should_flag",
	description: "must be caught",
	expect: { flagged: true, minSeverity: "high" },
});

// ── loadFixtures: happy path ──────────────────────────────────────────────────

describe("loadFixtures — valid pair", () => {
	test("loads the diff and returns the parsed label", () => {
		writeDiff("good", "DIFF-BODY");
		writeSidecar("good", validLabel);

		const fixtures = loadFixtures(dir);
		expect(fixtures.length).toBe(1);
		expect(fixtures[0]?.name).toBe("good");
		expect(fixtures[0]?.diff).toBe("DIFF-BODY");
		expect(fixtures[0]?.label.class).toBe("should_flag");
		expect(fixtures[0]?.label.expect.flagged).toBe(true);
	});
});

// ── loadFixtures: fail-loud conditions ────────────────────────────────────────

describe("loadFixtures — fails loud on malformed fixtures", () => {
	test("missing .expected.json sidecar throws (names the fixture)", () => {
		writeDiff("orphan");
		expect(() => loadFixtures(dir)).toThrow(/orphan/);
	});

	test("unparseable JSON sidecar throws", () => {
		writeDiff("broken");
		writeSidecar("broken", "{ not valid json ");
		expect(() => loadFixtures(dir)).toThrow(/broken/);
	});

	test("invalid class value throws", () => {
		writeDiff("badclass");
		writeSidecar(
			"badclass",
			JSON.stringify({
				class: "maybe_flag",
				description: "x",
				expect: { flagged: true },
			}),
		);
		expect(() => loadFixtures(dir)).toThrow(/class/);
	});

	test("missing expect.flagged throws", () => {
		writeDiff("noflag");
		writeSidecar(
			"noflag",
			JSON.stringify({
				class: "should_flag",
				description: "x",
				expect: { minSeverity: "high" },
			}),
		);
		expect(() => loadFixtures(dir)).toThrow(/flagged/);
	});

	test("non-boolean expect.flagged throws", () => {
		writeDiff("strflag");
		writeSidecar(
			"strflag",
			JSON.stringify({
				class: "should_flag",
				description: "x",
				expect: { flagged: "yes" },
			}),
		);
		expect(() => loadFixtures(dir)).toThrow(/flagged/);
	});
});

// ── readRuns ──────────────────────────────────────────────────────────────────

describe("readRuns", () => {
	test("returns default 5 when EVAL_RUNS is unset", () => {
		expect(readRuns({})).toBe(5);
	});

	test("returns the parsed value when EVAL_RUNS is a valid integer", () => {
		expect(readRuns({ EVAL_RUNS: "3" })).toBe(3);
	});

	test("returns default 5 (not NaN) when EVAL_RUNS is non-numeric", () => {
		const n = readRuns({ EVAL_RUNS: "abc" });
		expect(n).toBe(5);
		expect(Number.isNaN(n)).toBe(false);
	});
});
