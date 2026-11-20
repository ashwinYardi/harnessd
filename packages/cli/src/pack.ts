// The default skill pack (D-016): the skills `harnessd init` installs into
// ~/.harnessd/skills/. The build copies them from the repo's .claude/skills/ (see
// VENDORED.md there) into dist/pack/, so init needs no network and the pin is the
// package version plus the commits below. See docs/CONFIG.md "Skills".
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_DIR, PACK_MARKER } from "@harnessd/daemon";
import type { HookEvents } from "@harnessd/shared";

/** One default skill and the upstream commit this harnessd ships. */
export interface PackSkill {
  name: string;
  /** `owner/name` on GitHub. */
  upstream: string;
  commit: string;
  /** The upstream release, when it has one. */
  version?: string;
}

/**
 * The layout of a pack skill folder. init copies a folder again, at the same commit,
 * when its marker names an older format. 2 added `.harnessd-native/` (MET-30).
 */
export const PACK_FORMAT = 2;

// biome-ignore lint/suspicious/noTemplateCurlyInString: a variable the hook shell expands, not JS.
const IMPECCABLE_LAUNCHER = "${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/impeccable";
const claudeHook = (timeout: number, statusMessage: string) => ({
  type: "command",
  command: `[ ! -f "${IMPECCABLE_LAUNCHER}" ] || "${IMPECCABLE_LAUNCHER}" hook`,
  timeout,
  statusMessage,
});
const codexHook = (timeout: number, statusMessage: string) => ({
  type: "command",
  command: '".agents/skills/impeccable/scripts/impeccable" hook',
  commandWindows:
    'cmd /c if exist ".agents\\skills\\impeccable\\scripts\\impeccable.cmd" ".agents\\skills\\impeccable\\scripts\\impeccable.cmd" hook',
  timeout,
  statusMessage,
});

/**
 * Impeccable's design hook, as `npx impeccable@4.10.0 install --providers=claude,codex`
 * writes it (Claude Code moved into the shared `.claude/settings.json`). A test checks the
 * Claude Code part against the repo's `.claude/settings.json`.
 */
export const IMPECCABLE_HOOKS: { claude: HookEvents; codex: HookEvents } = {
  claude: {
    SessionStart: [{ hooks: [claudeHook(5, "Preparing build session")] }],
    PostToolUse: [{ matcher: "Edit|Write", hooks: [claudeHook(5, "Checking UI changes")] }],
    Stop: [{ hooks: [claudeHook(30, "Design deep pass")] }],
  },
  codex: {
    PostToolUse: [
      { matcher: "Edit|Write|apply_patch", hooks: [codexHook(5, "Checking UI changes")] },
    ],
    Stop: [{ hooks: [codexHook(30, "Design deep pass")] }],
  },
};

/** The manifest file in the pack folder: a JSON array of PackSkill. */
export const PACK_MANIFEST = "pack.json";

const MATT = { upstream: "mattpocock/skills", commit: "abeeaf95660ba9e8b7c753eb38f441ca707a8823" };
const MATT_LICENCE = "LICENSE-mattpocock-skills";

/** Keep in step with .claude/skills/VENDORED.md; a test checks it. */
export const PACK: readonly PackSkill[] = [
  ...[
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
    "domain-modeling",
    "grill-with-docs",
    "grilling",
    "implement",
    "improve-codebase-architecture",
    "prototype",
    "research",
    "tdd",
    "to-spec",
    "to-tickets",
  ].map((name) => ({ name, ...MATT })),
  {
    name: "impeccable",
    upstream: "pbakaus/impeccable",
    commit: "b49177d32788f2dc585c42831d845dacf1ebed2c",
    version: "4.10.0",
  },
];

/**
 * Adds impeccable's hook and its Claude Code agents (`<vendoredDir>/../agents/impeccable-*.md`,
 * from the same upstream commit) to the skill's `.harnessd-native/` folder.
 */
async function addImpeccableNative(vendoredDir: string, dest: string): Promise<void> {
  const native = join(dest, NATIVE_DIR);
  const agentsDir = join(vendoredDir, "..", "agents");
  await mkdir(join(native, "claude-agents"), { recursive: true });
  await writeFile(join(native, "hooks.json"), `${JSON.stringify(IMPECCABLE_HOOKS, null, 2)}\n`);
  for (const name of await readdir(agentsDir)) {
    if (!name.startsWith("impeccable-") || !name.endsWith(".md")) continue;
    await cp(join(agentsDir, name), join(native, "claude-agents", name));
  }
}

/**
 * Copies each pack skill's whole folder from `vendoredDir` to `outDir`, adds its
 * upstream licence as LICENSE where the folder has none, adds impeccable's harness
 * files, writes the marker, and writes the manifest. `outDir` is replaced.
 */
export async function buildPack(vendoredDir: string, outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const skill of PACK) {
    const dest = join(outDir, skill.name);
    await cp(join(vendoredDir, skill.name), dest, { recursive: true });
    if (skill.upstream === MATT.upstream) {
      await cp(join(vendoredDir, MATT_LICENCE), join(dest, "LICENSE"), { force: false });
    }
    if (skill.name === "impeccable") await addImpeccableNative(vendoredDir, dest);
    const marker = { upstream: skill.upstream, commit: skill.commit, format: PACK_FORMAT };
    await writeFile(join(dest, PACK_MARKER), `${JSON.stringify(marker)}\n`);
  }
  await writeFile(join(outDir, PACK_MANIFEST), `${JSON.stringify(PACK, null, 2)}\n`);
}
