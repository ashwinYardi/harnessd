// Build step: copies the default skill pack into dist/pack/ (src/pack.ts).
import { join } from "node:path";
import { buildPack } from "../src/pack.ts";

const pkg = join(import.meta.dirname, "..");
await buildPack(join(pkg, "../../.claude/skills"), join(pkg, "dist/pack"));
