// Tiny serializers for the native files `harnessd sync` writes. Deterministic on purpose:
// the same config always gives byte-identical output.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A TOML basic string. JSON escapes are valid TOML except that DEL must be escaped too. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

/** A TOML key, bare when it can be. */
export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

/** An inline TOML array of strings. */
export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

const YAML_PLAIN = /^[A-Za-z][\w .,()/'?!;-]*$/;
const YAML_RESERVED = /^(true|false|yes|no|on|off|null|y|n)$/i;

/** A YAML scalar: plain when unambiguous, else double-quoted (JSON strings are valid YAML). */
export function yamlString(value: string): string {
  if (YAML_PLAIN.test(value) && !value.endsWith(" ") && !YAML_RESERVED.test(value)) return value;
  return JSON.stringify(value);
}

/** Pretty JSON with a trailing newline. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
