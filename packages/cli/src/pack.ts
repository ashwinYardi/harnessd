// The default skill pack (D-016): the skills `harnessd init` installs into
// ~/.harnessd/skills/. The build copies them from the repo's .claude/skills/ (see
// VENDORED.md there) into dist/pack/, so init needs no network and the pin is the
// package version plus the commits below. See docs/CONFIG.md "Skills".
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PACK_MARKER } from "@harnessd/daemon";

/** One default skill and the upstream commit this harnessd ships. */
export interface PackSkill {
  name: string;
  /** `owner/name` on GitHub. */
  upstream: string;
  commit: string;
  /** The upstream release, when it has one. */
  version?: string;
}

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
 * Copies each pack skill's whole folder from `vendoredDir` to `outDir`, adds its
 * upstream licence as LICENSE where the folder has none, writes the marker, and
 * writes the manifest. `outDir` is replaced.
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
    const marker = { upstream: skill.upstream, commit: skill.commit };
    await writeFile(join(dest, PACK_MARKER), `${JSON.stringify(marker)}\n`);
  }
  await writeFile(join(outDir, PACK_MANIFEST), `${JSON.stringify(PACK, null, 2)}\n`);
}
