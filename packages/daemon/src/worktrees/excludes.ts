/**
 * `GIT_CONFIG_*` entries that set `core.excludesFile` after any the daemon already has.
 * Both the worktree sync and the removal guard use this, so the same files are hidden.
 */
export function excludesEnv(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.excludesFile",
    [`GIT_CONFIG_VALUE_${n}`]: file,
  };
}
