# Contributing

## Setup
Requires Node 24+ and pnpm 10 (`corepack enable`).

```sh
pnpm i && pnpm build && pnpm test
```

| Command | What it does |
|---|---|
| `pnpm build` | Compiles every package with `tsc` (turbo, cached) |
| `pnpm test` | Runs `node --test` on each package's `src/**/*.test.ts` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | Biome lint and format check; `pnpm format` fixes |

## Layout
```
packages/shared   types and contracts shared by everything else
packages/daemon   the harnessd daemon
packages/cli      the harnessd command (published as @harnessd/cli)
packages/ui       the web UI served by the daemon
docs/             SPEC.md, decisions/, RELEASING.md
```

Source is TypeScript that Node runs directly (type stripping), so tests need no build step of their own. Use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. Import relative files with their `.ts` extension; `tsc` rewrites them to `.js`.

## Workflow
1. Pick a **Ready** issue in Linear (team Meta Harness, project harnessd). Read docs/SPEC.md and docs/decisions/ first.
2. Branch `met-<n>-<slug>` from `main`. One issue, one branch, one small PR.
3. PR title is a conventional commit with the issue key: `feat(daemon): MET-10 read Ready issues from Linear`. Set the GitHub milestone that matches the issue's Linear milestone.
4. CI must be green. Every PR adds tests, or says why not.
5. PRs that pass CI and QA and touch no protected path are squash-merged (D-013). Protected paths (auth, payments, secrets, release config, merge-gate config) wait for a human.

A change that contradicts a decision ships with a new record in docs/decisions/.

## No vendor SDKs
Harness integration goes through each harness CLI only (D-002).
