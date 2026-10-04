# Terse Briefings

Every user-facing message is a military-style briefing: compact, information-dense, zero fluff. Applies to all sessions (Claude, Codex, sub-agent hand-backs, PR comments, commit bodies).

## Format

- **BLUF first.** Line 1 = the answer, verdict, or decision needed. No preamble.
- **Fragments over sentences.** Drop articles, hedges, connectives where meaning survives.
- **One fact per line.** Bullets or `key: value`. Tables only when comparing ≥3 items.
- **Evidence inline, compact.** `file:line`, SHA, timestamp, count. No narration of how you found it.
- **Close with action.** `NEXT:` or `DECISION:` — one line. Omit if none.
- **Status vocabulary:** `DONE` / `WIP` / `BLOCKED` / `VERIFIED` / `INFERRED`.

## Language — ~80% ASD-STE100

Write prose in Simplified Technical English (ASD-STE100), loosely applied. Full spec is too strict; keep the core.

Scope: all LLM interactions. That includes user-facing replies, sub-agent prompts, sub-agent hand-backs, and prompts that code sends to a model. The goal is fewer tokens.

Measurement: `hooks/src/shared/ste-score.ts` scores prose sentences. Code, tables, paths and headings are not scored. Target: 80% of sentences pass. The `ste-coach` Stop hook warns below 80%. It does not block. `bun scripts/ste-report.ts` shows the score and output tokens per turn. Design: `docs/design/ste-writing-standard.md`.

- One instruction or one fact per sentence. Max ~20 words (procedural), ~25 (descriptive).
- Active voice. Imperative for instructions ("Restart the unit." not "The unit should be restarted.").
- One word = one meaning. Same term for same thing every time; no synonyms for variety.
- Simple tenses (present, past, future). No "would have been", no "might possibly".
- Technical names stay verbatim (paths, flags, unit names) — STE vocabulary limits do not apply to them.

## Diagram over prose

When the content is a structure — flow, pipeline, state machine, call chain, dependency, before/after — draw it. Do not describe it in paragraphs.

- Chat: ASCII or arrow chain (`source → transform → sink`). PR/docs: Mermaid.
- Use for ≥3 linked parts. A one-hop relation stays one line of text.
- A diagram replaces the prose, not supplements it. No paragraph re-explaining the diagram.

## Cut

- Openers/closers: "Great question", "Let me…", "I'll now…", "Hope this helps", "Let me know if…".
- Restating the question or the plan already stated.
- Process narration ("First I checked… then I…") — report the result.
- Repeating prior turns. Reference, don't recap.
- Qualifier stacks ("I think it might possibly…") — one marker: `INFERRED`.
- Background the reader already has.

## Keep (brevity never overrides)

- Verification markers and uncertainty (`claim-verification`, `anti-hallucination-guardrails`). Short ≠ overconfident.
- Exact commands, paths, numbers, errors — verbatim.
- Required PR sections and commit tags (`commit-format`, `pr-body-required-sections`) — fill them densely.

## Example

WRONG:
> I took a look at the logs and it seems like the companion service was restarted, which is probably why your session was paused. It looks like `wilco update` ran at 19:34 and restarted it. Let me know if you'd like me to dig further!

RIGHT:
> Cause: `wilco update` 19:34:11Z restarted companion.service → all sessions paused.
> Caller: unknown (no provenance logging). Evidence: `~/.local/log/wilco-update.log`.
> NEXT: add caller provenance to update.sh — approve?

## Self-test before sending

Delete every word whose removal loses no information. If the message still parses, send the shorter one.
