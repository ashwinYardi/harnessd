import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Exec } from "../status/detect.ts";
import { createSecretStore, SecretError } from "./store.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-secrets-"));
  roots.push(root);
  return root;
}

const KEY = "lin_api_s3cretvalue0123456789";
const HOOK = "https://hooks.slack.com/services/T000/B000/s3cretHOOK";

test("save writes one 0600 file per secret in a 0700 folder, through a temp file", async () => {
  const dir = await home();
  const store = createSecretStore({ globalDir: dir, env: {} });
  assert.deepEqual(await store.state("linear.api_key"), {
    id: "linear.api_key",
    set: false,
    source: null,
    stored: false,
  });
  const saved = await store.save("linear.api_key", `  ${KEY}\n`);
  assert.deepEqual(saved, { id: "linear.api_key", set: true, source: "saved", stored: true });
  const folder = join(dir, "secrets");
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal((await stat(join(folder, "linear.api_key"))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(folder, "linear.api_key"), "utf8"), KEY);
  assert.deepEqual(await readdir(folder), ["linear.api_key"]);
  assert.deepEqual(await store.resolve("linear.api_key"), { value: KEY, source: "saved" });
});

test("save tightens a folder that is too open", async () => {
  const dir = await home();
  await mkdir(join(dir, "secrets"), { mode: 0o755 });
  const store = createSecretStore({ globalDir: dir, env: {} });
  await store.save("slack.webhook_url", HOOK);
  assert.equal((await stat(join(dir, "secrets"))).mode & 0o777, 0o700);
});

test("lookup order: saved value, then the environment variable", async () => {
  const dir = await home();
  const store = createSecretStore({ globalDir: dir, env: { LINEAR_API_KEY: "lin_api_fromenv" } });
  assert.deepEqual(await store.state("linear.api_key"), {
    id: "linear.api_key",
    set: true,
    source: "env",
    stored: false,
  });
  assert.deepEqual(await store.resolve("linear.api_key"), {
    value: "lin_api_fromenv",
    source: "env",
  });
  await store.save("linear.api_key", KEY);
  assert.equal(await store.value("linear.api_key"), KEY);
  await store.remove("linear.api_key");
  assert.equal(await store.value("linear.api_key"), "lin_api_fromenv");
  assert.deepEqual(await readdir(join(dir, "secrets")), []);
});

test("a reference is written to config.toml, never the value, and replaces a saved file", async () => {
  const dir = await home();
  await writeFile(join(dir, "config.toml"), '# mine\n[linear]\nteam_id = "MET"\n');
  const store = createSecretStore({ globalDir: dir, env: { MY_HOOK: HOOK } });
  await store.save("slack.webhook_url", "https://hooks.slack.com/services/old");
  const state = await store.save("slack.webhook_url", "env:MY_HOOK");
  // An env: reference is stored here, so it can be removed, unlike the variable fallback.
  assert.deepEqual(state, { id: "slack.webhook_url", set: true, source: "env", stored: true });
  assert.equal(
    await readFile(join(dir, "config.toml"), "utf8"),
    '# mine\n[linear]\nteam_id = "MET"\n\n[secrets.slack]\nwebhook_url = "env:MY_HOOK"\n',
  );
  assert.deepEqual(await readdir(join(dir, "secrets")), []);
  assert.deepEqual(await store.resolve("slack.webhook_url"), { value: HOOK, source: "env" });

  // A saved value replaces the reference.
  await store.save("slack.webhook_url", HOOK);
  assert.equal(
    await readFile(join(dir, "config.toml"), "utf8"),
    '# mine\n[linear]\nteam_id = "MET"\n',
  );
  assert.equal((await store.resolve("slack.webhook_url"))?.source, "saved");
});

test("an op:// reference is read with the op CLI at use time, argv only, and cached", async () => {
  const dir = await home();
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: `${KEY}\n`, stderr: "" };
  };
  let now = 0;
  const store = createSecretStore({ globalDir: dir, env: {}, exec, now: () => now });
  const ref = "op://Private/Linear API; rm -rf ~/credential";
  await assert.rejects(store.save("linear.api_key", "op://Private"), SecretError);
  await assert.rejects(store.save("linear.api_key", ref), SecretError);
  await store.save("linear.api_key", "op://Private/Linear/credential");
  assert.deepEqual(await store.state("linear.api_key"), {
    id: "linear.api_key",
    set: true,
    source: "1Password",
    stored: true,
  });
  assert.equal(calls.length, 0, "state never runs op");
  assert.deepEqual(await store.resolve("linear.api_key"), { value: KEY, source: "1Password" });
  await store.resolve("linear.api_key");
  assert.deepEqual(calls, [
    { cmd: "op", args: ["read", "--no-newline", "op://Private/Linear/credential"] },
  ]);
  now += 10 * 60_000;
  await store.resolve("linear.api_key");
  assert.equal(calls.length, 2, "the cache expires");
});

test("a failed op read is a SecretError that names the reference source, not a value", async () => {
  const dir = await home();
  const results = [
    { code: 127, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: `[ERROR] could not read ${KEY}\nmore` },
    { code: 124, stdout: "", stderr: "" },
  ];
  const exec: Exec = async () => results.shift() ?? { code: 1, stdout: "", stderr: "" };
  const store = createSecretStore({ globalDir: dir, env: {}, exec });
  // A value this store has seen is masked in op's error output too.
  await store.save("linear.api_key", KEY);
  await store.save("linear.api_key", "op://Private/Linear/credential");
  const messages: string[] = [];
  for (let i = 0; i < 3; i++) {
    await assert.rejects(store.resolve("linear.api_key"), (e: unknown) => {
      assert.ok(e instanceof SecretError);
      messages.push(e.message);
      return true;
    });
  }
  assert.deepEqual(messages, [
    "1Password: the op CLI is not installed",
    "1Password: op read failed: [ERROR] could not read ***",
    "1Password: op read timed out",
  ]);
});

test("an env: reference to an unset variable is an error, not a silent fallback", async () => {
  const dir = await home();
  const store = createSecretStore({ globalDir: dir, env: { LINEAR_API_KEY: "lin_api_fromenv" } });
  await store.save("linear.api_key", "env:OTHER_KEY");
  await assert.rejects(
    store.resolve("linear.api_key"),
    (e: unknown) => e instanceof SecretError && e.message === "env:OTHER_KEY is not set",
  );
});

test("invalid values are refused, and the error never repeats them", async () => {
  const dir = await home();
  const store = createSecretStore({ globalDir: dir, env: {} });
  const bad: Array<[Parameters<typeof store.save>[0], string]> = [
    ["linear.api_key", ""],
    ["linear.api_key", "lin_api_a b"],
    ["linear.api_key", "lin_api_\u0007x"],
    ["linear.api_key", "x".repeat(5000)],
    ["slack.webhook_url", "http://hooks.slack.com/services/plain"],
    ["slack.webhook_url", "s3cret-not-a-url"],
    ["slack.webhook_url", "env:9NOPE"],
  ];
  for (const [id, value] of bad) {
    await assert.rejects(
      store.save(id, value),
      (e: unknown) =>
        e instanceof SecretError &&
        e.code === "invalid" &&
        (value.trim() === "" || !e.message.includes(value.trim())),
    );
  }
  assert.deepEqual(await readdir(dir), []);
});

test("known() lists every value read, longest first, for redaction", async () => {
  const dir = await home();
  const store = createSecretStore({
    globalDir: dir,
    env: { HARNESSD_SLACK_WEBHOOK_URL: HOOK },
  });
  await store.save("linear.api_key", KEY);
  await store.resolve("linear.api_key");
  await store.resolve("slack.webhook_url");
  assert.deepEqual(store.known(), [HOOK, KEY]);
});

test("a saved file that others can read, or a link, is refused, and Replace still works", async () => {
  const dir = await home();
  const store = createSecretStore({ globalDir: dir, env: {} });
  await store.save("linear.api_key", KEY);
  await chmod(join(dir, "secrets", "linear.api_key"), 0o644);
  await assert.rejects(
    store.resolve("linear.api_key"),
    (e: unknown) =>
      e instanceof SecretError &&
      e.message === "the saved linear.api_key can be read by others; save it again",
  );
  assert.deepEqual(await store.state("linear.api_key"), {
    id: "linear.api_key",
    set: true,
    source: "saved",
    stored: true,
  });
  await store.save("linear.api_key", KEY);
  assert.equal(await store.value("linear.api_key"), KEY);

  await rm(join(dir, "secrets", "linear.api_key"));
  await writeFile(join(dir, "elsewhere"), KEY, { mode: 0o600 });
  await symlink(join(dir, "elsewhere"), join(dir, "secrets", "linear.api_key"));
  await assert.rejects(store.resolve("linear.api_key"), /not a plain file/);
});

test("a secrets folder that is a link is refused before any write", async () => {
  const dir = await home();
  const other = await home();
  await symlink(other, join(dir, "secrets"));
  const store = createSecretStore({ globalDir: dir, env: {} });
  await assert.rejects(store.save("linear.api_key", KEY), /is not a plain folder/);
  assert.deepEqual(await readdir(other), []);
});

test("writing a reference keeps config.toml's own mode", async () => {
  const dir = await home();
  await writeFile(join(dir, "config.toml"), "[daemon]\nport = 4747\n", { mode: 0o600 });
  const store = createSecretStore({ globalDir: dir, env: {} });
  await store.save("linear.api_key", "env:MY_KEY");
  assert.equal((await stat(join(dir, "config.toml"))).mode & 0o777, 0o600);
});
