# D-045 Turn caps, tool-output caps and OpenCode compaction per role and harness

Status: accepted 2026-11-22. Issue: MET-149 (parent MET-142). Amends D-043 and D-038. Extends D-031, D-032, D-036 and D-014.

MET-142 says every run has a turn cap, a tool-output cap and context compaction per role and harness. D-043 decided to add no OpenCode option and to lower no cap; this record reverses that for caps and compaction. D-043 and D-038 stay as written.

## Turn cap

A MET-128 build took about 65 turns. The builds measured on 2026-11-22 took 190 turns. The cap stops the second kind.

- `limits.max_turns` is a new optional key, keyed by size like `budget_minutes`: defaults **S 80** and **M 160**. It applies to builder part runs (backend and frontend) and to their size. A value is a positive integer per size; zero, a negative number, a non-integer or a size key other than S or M is a config error, as for `budget_minutes`. It merges per layer like the other `limits` keys. An unknown size counts as M.
- The role caps are fixed in code, not config: **QA 40**, **coordinator grill and plan 50**. `maxTurns(role, size, limits)` in `coordinator/dispatch.ts` is the one place that answers.
- **Claude Code:** `--max-turns <n>` is added to the argv. A result event with subtype `error_max_turns` ends the run `error` with `turn cap (<n> turns)` and no failure `reason`.
- **Codex and OpenCode:** the adapter counts turns and kills the process group at the cap the way a cancel does, but reports `error` with `turn cap (<n> turns)`, not `cancelled`. OpenCode counts `step_start`. Codex counts each **completed tool item**: a command run, a file change, an MCP tool call or a web search. `codex exec` sends one `turn.completed` for each prompt, so that count cannot cap a long run; the tool-item count also goes in the D-043 log line, so the cap and the log agree. A `todo_list` item is not a turn. A real run of codex-cli 0.171.0 on 2026-11-22 sent one `turn.completed` for one prompt, with no tool item.
- A turn-capped run follows the normal error rule: it counts one attempt, it is not shipped, and the keep guard keeps unshipped work for the next attempt on the same branch. A turn-capped QA run counts as a QA failure. A turn-capped grill or plan run is an error run, and the plan uses the one-part fallback.
- The wall-clock budget and the weighted token budget stay. The first limit a run hits stops it. A time-budget stop stays `timeout`.

**Why these numbers.** A MET-128 build weighed 1,470,055 tokens over about 65 turns, about **22.6k weighted tokens per turn**. 80 turns is about **1.8M**, under the S budget of 3M; 160 turns is about **3.6M**, under the M budget of 6M. A 65-turn build fits S with room to spare. The 190-turn builds are the runaway case.

## Tool-output cap

Each cap keeps one tool result near 5k tokens. One 50 KiB result is about 12.8k tokens, and every later turn sends it again.

- **Claude Code 2.1.329:** `BASH_MAX_OUTPUT_LENGTH=20000` in the child's environment for every run, about 5k tokens of one Bash result. The default is 30,000 characters.
- **Codex, minimum 0.171.0:** `-c tool_output_token_limit=5000`, with the other `-c` options and before `--`.
- **OpenCode 2.3.2:** the docs and the config schema document `tool_output.max_lines` (default 2,000) and `max_bytes` (default 51,200, about 50 KiB). Builder worktree sync writes `tool_output.max_bytes = 20000` and `max_lines = 2000`. Owner, QA and coordinator sync write no `tool_output` key. D-043's statement that the OpenCode cap is already on is true; what changes is that a builder run lowers it.

## OpenCode compaction for builder runs

Builder worktree sync writes `compaction` into `opencode.json` on OpenCode 2.3.2:

```json
{ "auto": true, "keep": { "tokens": 20000 }, "buffer": "50%" }
```

- The docs define `buffer` as the share of the model's context window kept free before automatic compaction starts. On a 200k window, `"50%"` starts compaction at about 100k tokens, the MET-131 target. The 190k average turn is close to that window.
- `keep.tokens = 20000` is above the documented default of 15,000. The 100k start leaves room for a summary plus the 20k recent tail.
- Owner sync, QA sync and coordinator sync do not write `compaction`.
- Every key written here is one the OpenCode 2.3.2 docs and schema list.

## Sync ownership

D-038 gave sync `$schema`, `mcp`, `permission` and `websearch` in `opencode.json`. Sync now also owns `compaction` and `tool_output` for a builder worktree run. It replaces each as a whole key, as it does for `permission`, and writes them only when the run's role is backend or frontend. The existing merge keeps every user-owned key.

## Tests and docs

- Config: the S 80 and M 160 defaults, the per-layer merge, an unknown size counts as M, and invalid values fail.
- Claude: the argv has `--max-turns`; the env has `BASH_MAX_OUTPUT_LENGTH=20000`; an `error_max_turns` fixture gives `error` with `turn cap`.
- Codex: the argv has `-c tool_output_token_limit=5000`; the tools fixture counts four completed tool items; a run over the cap is killed with `error` and `turn cap`.
- OpenCode: a `step_start` fixture over the cap gives the same result.
- Sync: a builder `opencode.json` has `compaction` and `tool_output`; QA and coordinator files have neither.
- Loop: a turn-capped part counts one attempt, is not shipped, and passes S 80 to the adapter.
- `docs/CONFIG.md` gives the key, the role caps, each option with its tested version, the compaction values and the numbers. `docs/LOOP.md` updates "What an agent run sees", the run-end table and the run log line.
