import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../config/load.ts";
import { resolveAgentConfig } from "../config/merge.ts";
import { startDaemon } from "../server/daemon.ts";
import type { ExecResult } from "../status/detect.ts";
import type { Check } from "../status/status.ts";
import { MODELS_CACHE_MS, type SetupOptions, setupRoutes, spawnRunner } from "./routes.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const WORKSPACE = `# Team for this repo.
[linear]
team_id = "MET"

# Docs writer.
[agents.docs]
role = "frontend"
harness = "claude-code"
`;

const CHECKS: Check[] = [
  { id: "node", state: "ok", detail: "v24", fix: "" },
  { id: "harness.claude-code.cli", state: "ok", detail: "2.1.4 (/bin/claude)", fix: "" },
  {
    id: "harness.claude-code.auth",
    state: "fail",
    detail: "not signed in",
    fix: "Run: claude auth login",
  },
  {
    id: "harness.claude-code.version",
    state: "ok",
    detail: "2.1.4 has no known problems",
    fix: "",
  },
  {
    id: "harness.codex.cli",
    state: "missing",
    detail: "codex is not on PATH",
    fix: "Install it: npm i -g @openai/codex",
  },
  {
    id: "harness.codex.auth",
    state: "missing",
    detail: "not checked",
    fix: "Fix harness.codex.cli first.",
  },
  {
    id: "harness.codex.version",
    state: "missing",
    detail: "not checked",
    fix: "Fix harness.codex.cli first.",
  },
];

async function serve(extra: Partial<SetupOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-setup-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repoDir, ".harnessd"), { recursive: true });
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(repoDir, ".harnessd", "config.toml"), WORKSPACE);
  await writeFile(join(globalDir, "config.toml"), "# Machine settings.\n[daemon]\nport = 4747\n");
  const runs: string[] = [];
  const syncs: string[] = [];
  let finish: (code: number) => void = () => {};
  const setup = setupRoutes({
    repoDir,
    globalDir,
    env: {},
    checks: async () => CHECKS,
    isExecutable: async (p) => p === "/opt/bin/claude",
    runner: (cmd, args, onLine) => {
      runs.push([cmd, ...args].join(" "));
      onLine("added 1 package");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    sync: async (o) => {
      syncs.push(o.repoDir);
      return { changed: ["AGENTS.md"], skipped: [], paths: ["AGENTS.md"] };
    },
    ...extra,
  });
  const daemon = await startDaemon({ routes: setup.routes });
  const get = async (path: string) => (await fetch(daemon.url + path)).json();
  const post = (path: string, body: unknown) =>
    fetch(daemon.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    repoDir,
    globalDir,
    runs,
    syncs,
    get,
    post,
    finish: (code: number) => finish(code),
    close: () => daemon.close(),
  };
}

test("GET /api/harnesses has one card per harness, from the status checks", async () => {
  const s = await serve();
  try {
    const body = (await s.get("/api/harnesses")) as {
      harnesses: Array<{
        id: string;
        name: string;
        required: boolean;
        checks: Check[];
        commands: Record<string, string>;
      }>;
    };
    assert.deepEqual(
      body.harnesses.map((h) => [h.id, h.name, h.required, h.checks.map((c) => c.id)]),
      [
        [
          "claude-code",
          "Claude Code",
          true,
          ["harness.claude-code.cli", "harness.claude-code.auth", "harness.claude-code.version"],
        ],
        [
          "codex",
          "Codex",
          false,
          ["harness.codex.cli", "harness.codex.auth", "harness.codex.version"],
        ],
        ["opencode", "OpenCode", false, []],
      ],
    );
    assert.deepEqual(body.harnesses[2]?.commands, {
      install: "curl -fsSL https://opencode.ai/install | bash",
      update: "opencode upgrade",
      signin: "opencode auth login <provider>",
    });
    assert.deepEqual(body.harnesses[0]?.commands, {
      install: "npm install -g @anthropic-ai/claude-code",
      update: "npm install -g @anthropic-ai/claude-code@latest",
      signin: "claude auth login",
    });
  } finally {
    await s.close();
  }
});

test("Install runs only the fixed command, streams its output and reports the result", async () => {
  const s = await serve();
  try {
    const started = await s.post("/api/harnesses/codex/install", {});
    assert.equal(started.status, 200);
    const job = (await started.json()) as { id: string; state: string; command: string };
    assert.equal(job.state, "running");
    assert.equal(job.command, "npm install -g @openai/codex");
    assert.deepEqual(s.runs, ["npm install -g @openai/codex"]);

    const busy = await s.post("/api/harnesses/codex/update", {});
    assert.equal(busy.status, 409);

    s.finish(1);
    await new Promise((r) => setTimeout(r, 10));
    const codex = (
      (await s.get("/api/harnesses")) as { harnesses: Array<{ id: string; job: unknown }> }
    ).harnesses.find((h) => h.id === "codex");
    assert.deepEqual(codex?.job as { state: string; lines: string[]; exitCode: number }, {
      ...(codex?.job as object),
      state: "failed",
      exitCode: 1,
      lines: ["added 1 package"],
    });
  } finally {
    await s.close();
  }
});

test("an action takes no text from the request: extra keys and unknown actions are refused", async () => {
  const s = await serve();
  try {
    const extra = await s.post("/api/harnesses/codex/install", { package: "evil; rm -rf /" });
    assert.equal(extra.status, 400);
    assert.equal(((await extra.json()) as { error: string }).error, "invalid_body");
    assert.equal((await s.post("/api/harnesses/codex/uninstall", {})).status, 404);
    assert.equal((await s.post("/api/harnesses/vim/install", {})).status, 404);
    assert.deepEqual(s.runs, []);
  } finally {
    await s.close();
  }
});

const CLAUDE_BIN = '\n[harnesses.claude-code]\nbin = "/opt/bin/claude"\n';

async function withClaudeBin(s: { globalDir: string }) {
  const file = join(s.globalDir, "config.toml");
  await writeFile(file, (await readFile(file, "utf8")) + CLAUDE_BIN);
}

const settle = () => new Promise((r) => setTimeout(r, 10));

async function jobOf(s: { get: (p: string) => Promise<unknown> }, id: string) {
  const body = (await s.get("/api/harnesses")) as {
    harnesses: Array<{ id: string; job: Record<string, unknown> | null }>;
  };
  return body.harnesses.find((h) => h.id === id)?.job ?? null;
}

// Sign-in has no platform branch any more (D-031), so SetupOptions takes no platform.
test("Sign in runs the resolved CLI with its own login argv, not Terminal", async () => {
  const s = await serve();
  try {
    await withClaudeBin(s);
    const res = await s.post("/api/harnesses/claude-code/signin", {});
    assert.equal(res.status, 200);
    const job = (await res.json()) as { command: string; state: string };
    assert.equal(job.command, "claude auth login");
    assert.equal(job.state, "running");
    assert.deepEqual(s.runs, ["/opt/bin/claude auth login"]);
    assert.doesNotMatch(s.runs.join("\n"), /osascript|Terminal/);
  } finally {
    await s.close();
  }
});

test("Sign in for Codex takes HARNESSD_CODEX_BIN and runs `login` with no extra flags", async () => {
  const s = await serve({
    env: { HARNESSD_CODEX_BIN: "/opt/bin/codex" },
    isExecutable: async (p) => p === "/opt/bin/codex",
  });
  try {
    assert.equal((await s.post("/api/harnesses/codex/signin", {})).status, 200);
    assert.deepEqual(s.runs, ["/opt/bin/codex login"]);
  } finally {
    await s.close();
  }
});

test("Sign in with no CLI found is a 400 that names the problem, and runs nothing", async () => {
  const s = await serve();
  try {
    const res = await s.post("/api/harnesses/claude-code/signin", {});
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "not_installed");
    assert.match(body.message, /claude is not on PATH/);
    assert.deepEqual(s.runs, []);
  } finally {
    await s.close();
  }
});

test("the sign-in job carries the first login URL and device code, masked of env secrets", async () => {
  const s = await serve({
    env: { OPENAI_API_KEY: "sk-secret-value" },
    runner: async (_cmd, _args, onLine) => {
      onLine("Using key sk-secret-value");
      onLine("Open https://auth.example.com/device in your browser.");
      onLine("Enter this one-time code: ABCD-1234");
      onLine("Or open https://other.example.com and enter WXYZ-9876");
      return 0;
    },
  });
  try {
    await withClaudeBin(s);
    assert.equal((await s.post("/api/harnesses/claude-code/signin", {})).status, 200);
    await settle();
    const job = await jobOf(s, "claude-code");
    assert.equal(job?.state, "ok");
    assert.equal(job?.url, "https://auth.example.com/device");
    assert.equal(job?.code, "ABCD-1234");
    assert.equal((job?.lines as string[] | undefined)?.[0], "Using key ***");
    assert.doesNotMatch(JSON.stringify(job), /sk-secret-value|Terminal/);
  } finally {
    await s.close();
  }
});

test("a sign-in that fails with no URL is failed and has no url or code", async () => {
  const s = await serve({
    runner: async (_cmd, _args, onLine) => {
      onLine("error: could not reach the login server");
      return 2;
    },
  });
  try {
    await withClaudeBin(s);
    await s.post("/api/harnesses/claude-code/signin", {});
    await settle();
    const job = await jobOf(s, "claude-code");
    assert.equal(job?.state, "failed");
    assert.equal(job?.exitCode, 2);
    assert.equal("url" in (job ?? {}), false);
    assert.equal("code" in (job ?? {}), false);
  } finally {
    await s.close();
  }
});

test("install output is not read for a login URL", async () => {
  const s = await serve({
    runner: async (_cmd, _args, onLine) => {
      onLine("see https://docs.example.com and enter ABCD-1234");
      return 0;
    },
  });
  try {
    await s.post("/api/harnesses/codex/install", {});
    await settle();
    const job = await jobOf(s, "codex");
    assert.equal(job?.url, undefined);
    assert.equal(job?.code, undefined);
  } finally {
    await s.close();
  }
});

test("sign-in runs a real fake CLI from [harnesses.<id>] bin and reads its prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-fake-cli-"));
  roots.push(root);
  const bin = join(root, "claude");
  await writeFile(
    bin,
    [
      "#!/bin/sh",
      '[ "$1 $2" = "auth login" ] || { echo "bad argv: $*" >&2; exit 9; }',
      'echo "Opening https://login.example.com/oauth?state=x"',
      'echo "Enter code: QWER-TYUI" >&2',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const s = await serve({ runner: spawnRunner, isExecutable: async (p) => p === bin });
  try {
    const file = join(s.globalDir, "config.toml");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}\n[harnesses.claude-code]\nbin = "${bin}"\n`,
    );
    assert.equal((await s.post("/api/harnesses/claude-code/signin", {})).status, 200);
    let job = await jobOf(s, "claude-code");
    for (let i = 0; i < 200 && job?.state === "running"; i++) {
      await settle();
      job = await jobOf(s, "claude-code");
    }
    assert.equal(job?.state, "ok", JSON.stringify(job));
    assert.equal(job?.url, "https://login.example.com/oauth?state=x");
    assert.equal(job?.code, "QWER-TYUI");
  } finally {
    await s.close();
  }
});

test("the binary path is checked, then saved in the global config with its comments", async () => {
  const s = await serve();
  try {
    const relative = await s.post("/api/harnesses/claude-code/path", { path: "bin/claude" });
    assert.equal(relative.status, 400);
    const absent = await s.post("/api/harnesses/claude-code/path", { path: "/opt/bin/nope" });
    assert.equal(absent.status, 400);
    assert.match(((await absent.json()) as { message: string }).message, /not an executable file/);

    const saved = await s.post("/api/harnesses/claude-code/path", { path: "/opt/bin/claude" });
    assert.equal(saved.status, 200);
    const file = await readFile(join(s.globalDir, "config.toml"), "utf8");
    assert.equal(
      file,
      '# Machine settings.\n[daemon]\nport = 4747\n\n[harnesses.claude-code]\nbin = "/opt/bin/claude"\n',
    );

    await s.post("/api/harnesses/claude-code/path", { path: null });
    assert.equal(
      await readFile(join(s.globalDir, "config.toml"), "utf8"),
      "# Machine settings.\n[daemon]\nport = 4747\n",
    );
  } finally {
    await s.close();
  }
});

test("GET /api/team lists every agent and which ones can be removed", async () => {
  const s = await serve();
  try {
    const body = (await s.get("/api/team")) as {
      agents: Array<{ name: string; role: string; harness: string; removable: boolean }>;
    };
    assert.deepEqual(
      body.agents.map((a) => [a.name, a.role, a.harness, a.removable]),
      [
        ["coordinator", "coordinator", "claude-code", false],
        ["backend", "backend", "claude-code", false],
        ["frontend", "frontend", "claude-code", false],
        ["qa", "qa", "claude-code", false],
        ["docs", "frontend", "claude-code", true],
      ],
    );
  } finally {
    await s.close();
  }
});

const TEAM = [
  { name: "coordinator", role: "coordinator", harness: "claude-code" },
  { name: "backend", role: "backend", harness: "codex", model: "gpt-5" },
  { name: "frontend", role: "frontend", harness: "claude-code" },
  { name: "qa", role: "qa", harness: "claude-code" },
  { name: "reviewer", role: "qa", harness: "claude-code", model: "opus" },
];

test("POST /api/team writes only the changes, keeps comments, then runs sync", async () => {
  const s = await serve();
  try {
    const res = await s.post("/api/team", { agents: TEAM });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { synced: string[] };
    assert.deepEqual(body.synced, ["AGENTS.md"]);
    assert.deepEqual(s.syncs, [s.repoDir]);
    const file = await readFile(join(s.repoDir, ".harnessd", "config.toml"), "utf8");
    assert.equal(
      file,
      `# Team for this repo.
[linear]
team_id = "MET"

[agents.backend]
role = "backend"
harness = "codex"
model = "gpt-5"

[agents.reviewer]
role = "qa"
harness = "claude-code"
model = "opus"
`,
    );
  } finally {
    await s.close();
  }
});

test("a saved backend row with harness codex passes the config validator and runs sync", async () => {
  const s = await serve();
  try {
    const team = [
      { name: "coordinator", role: "coordinator", harness: "claude-code" },
      { name: "backend", role: "backend", harness: "codex" },
      { name: "frontend", role: "frontend", harness: "claude-code" },
      { name: "qa", role: "qa", harness: "claude-code" },
      { name: "docs", role: "frontend", harness: "claude-code" },
    ];
    const res = await s.post("/api/team", { agents: team });
    assert.equal(res.status, 200);
    assert.deepEqual(s.syncs, [s.repoDir]);
    const file = await readFile(join(s.repoDir, ".harnessd", "config.toml"), "utf8");
    assert.match(file, /\[agents\.backend\]\nrole = "backend"\nharness = "codex"\n/);
    const merged = await loadConfig({
      globalDir: s.globalDir,
      workspaceDir: join(s.repoDir, ".harnessd"),
    });
    assert.equal(resolveAgentConfig(merged, "backend").harness, "codex");
    const listed = (await s.get("/api/team")) as {
      agents: Array<{ name: string; harness: string }>;
    };
    assert.equal(listed.agents.find((a) => a.name === "backend")?.harness, "codex");
  } finally {
    await s.close();
  }
});

test("an invalid team writes nothing and names each bad field", async () => {
  const s = await serve();
  try {
    const res = await s.post("/api/team", {
      agents: [...TEAM.slice(0, 4), { name: "Bad Name", role: "qa", harness: "claude-code" }],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    assert.equal(body.error, "invalid_body");
    assert.deepEqual(Object.keys(body.fields), ["4.name"]);
    const noDefault = await s.post("/api/team", { agents: TEAM.slice(1) });
    assert.equal(noDefault.status, 400);
    assert.equal(await readFile(join(s.repoDir, ".harnessd", "config.toml"), "utf8"), WORKSPACE);
    assert.deepEqual(s.syncs, []);
  } finally {
    await s.close();
  }
});

test("the binary path must name the harness's own CLI", async () => {
  const s = await serve({ isExecutable: async () => true });
  try {
    const other = await s.post("/api/harnesses/claude-code/path", { path: "/usr/bin/python3" });
    assert.equal(other.status, 400);
    assert.match(((await other.json()) as { message: string }).message, /must end in \/claude/);
    assert.equal((await s.post("/api/harnesses/codex/path", { path: "/opt/codex" })).status, 200);
  } finally {
    await s.close();
  }
});

test("a broken workspace config is a 400 that names the key, not an internal error", async () => {
  const s = await serve();
  try {
    await writeFile(
      join(s.repoDir, ".harnessd", "config.toml"),
      '[limits]\nmax_concurrent = "x"\n',
    );
    const body = (await s.get("/api/team")) as { error: string; message: string };
    assert.equal(body.error, "invalid_config");
    assert.match(body.message, /max_concurrent/);
  } finally {
    await s.close();
  }
});

// OpenCode (MET-92). A fake `opencode` script answers with recorded output and logs argv.
const AUTH_LIST = JSON.stringify([
  { id: "opencode", name: "OpenCode Zen", connections: [{ type: "credential", method: "oauth" }] },
  { id: "deepseek", name: "DeepSeek", connections: [{ type: "credential", method: "key" }] },
  { id: "Bad Id", name: "ignored", connections: [{ type: "credential" }] },
]);
const MODELS = [
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "openrouter/qwen/qwen3-coder:free",
  "not a model",
  "Bad/upper-provider",
  "deepseek/deepseek-chat",
  "",
].join("\n");

async function fakeOpencode(models = MODELS, auth = AUTH_LIST) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-fake-opencode-"));
  roots.push(root);
  const bin = join(root, "opencode");
  const log = join(root, "argv.log");
  await writeFile(join(root, "models.txt"), models);
  await writeFile(join(root, "auth.json"), auth);
  await writeFile(
    bin,
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      `  "auth list --format json --standalone") cat '${join(root, "auth.json")}' ;;`,
      `  "models --standalone") cat '${join(root, "models.txt")}' ;;`,
      '  *) echo "bad argv: $*" >&2; exit 9 ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
  return { bin, calls };
}

const OPENCODE_TEAM = `${WORKSPACE}
[agents.builder]
role = "backend"
harness = "opencode"
model = "kimi/kimi-k2"
`;

async function serveOpencode(extra: Partial<SetupOptions> = {}, models?: string) {
  const fake = await fakeOpencode(models);
  let clock = 1_000_000;
  const s = await serve({
    env: { HARNESSD_OPENCODE_BIN: fake.bin },
    isExecutable: async (p) => p === fake.bin,
    now: () => clock,
    ...extra,
  });
  await writeFile(join(s.repoDir, ".harnessd", "config.toml"), OPENCODE_TEAM);
  return { ...s, fake, tick: (ms: number) => (clock += ms) };
}

test("GET /api/setup/opencode/models lists valid provider/model ids once each, and caches them", async () => {
  const s = await serveOpencode();
  try {
    const want = {
      models: [
        "deepseek/deepseek-chat",
        "deepseek/deepseek-reasoner",
        "openrouter/qwen/qwen3-coder:free",
      ],
    };
    assert.deepEqual(await s.get("/api/setup/opencode/models"), want);
    s.tick(MODELS_CACHE_MS - 1);
    assert.deepEqual(await s.get("/api/setup/opencode/models"), want);
    assert.deepEqual(await s.fake.calls(), ["models --standalone"]);
    s.tick(1);
    assert.deepEqual(await s.get("/api/setup/opencode/models"), want);
    assert.deepEqual(await s.fake.calls(), ["models --standalone", "models --standalone"]);
    assert.deepEqual(s.runs, []);
  } finally {
    await s.close();
  }
});

test("the models route gives an empty list and a reason, never a 500", async () => {
  const missing = await serve();
  try {
    const res = (await missing.get("/api/setup/opencode/models")) as {
      models: string[];
      reason: string;
    };
    assert.deepEqual(res.models, []);
    assert.match(res.reason, /opencode is not on PATH/);
  } finally {
    await missing.close();
  }
  const empty = await serveOpencode({}, "\n");
  try {
    const res = (await empty.get("/api/setup/opencode/models")) as {
      models: string[];
      reason: string;
    };
    assert.deepEqual(res.models, []);
    assert.match(res.reason, /no models/);
  } finally {
    await empty.close();
  }
  const replies: ExecResult[] = [
    { code: 124, stdout: "", stderr: "" },
    { code: 2, stdout: "", stderr: "Error: token sk-secret-value\n" },
  ];
  const broken = await serveOpencode({
    env: { HARNESSD_OPENCODE_BIN: "/opt/bin/opencode", OPENAI_API_KEY: "sk-secret-value" },
    isExecutable: async (p) => p === "/opt/bin/opencode",
    exec: async () => replies.shift() ?? { code: 0, stdout: "", stderr: "" },
  });
  try {
    const timeout = (await broken.get("/api/setup/opencode/models")) as { reason: string };
    assert.match(timeout.reason, /timed out after 30 s/);
    const failed = (await broken.get("/api/setup/opencode/models")) as { reason: string };
    assert.equal(failed.reason, "opencode models --standalone exited 2: Error: token ***");
  } finally {
    await broken.close();
  }
});

test("GET /api/setup/opencode/providers lists signed-in and required providers, ids only", async () => {
  const s = await serveOpencode();
  try {
    assert.deepEqual(await s.get("/api/setup/opencode/providers"), {
      providers: [
        {
          id: "deepseek",
          signedIn: true,
          required: false,
          command: "opencode auth login deepseek",
        },
        { id: "kimi", signedIn: false, required: true, command: "opencode auth login kimi" },
        {
          id: "opencode",
          signedIn: true,
          required: false,
          command: "opencode auth login opencode",
        },
      ],
    });
  } finally {
    await s.close();
  }
});

test("provider sign-in runs `opencode auth login --standalone -- <provider>` from the daemon's own set", async () => {
  const s = await serveOpencode();
  try {
    const res = await s.post("/api/setup/opencode/providers/kimi/signin", {});
    assert.equal(res.status, 200);
    const job = (await res.json()) as { command: string; provider: string; state: string };
    assert.equal(job.command, "opencode auth login kimi");
    assert.equal(job.provider, "kimi");
    assert.deepEqual(s.runs, [`${s.fake.bin} auth login --standalone -- kimi`]);
    // stdin is closed, so a provider that waits for a typed key fails: the job gives the command.
    s.finish(1);
    await settle();
    const done = await jobOf(s, "opencode");
    assert.equal(done?.state, "failed");
    assert.equal(done?.manual, "opencode auth login kimi");
    const body = await s.post("/api/setup/opencode/providers/deepseek/signin", { key: "sk-x" });
    assert.equal(body.status, 400);
  } finally {
    await s.close();
  }
});

test("provider sign-in refuses an id outside the set or the regex with a 404, and runs nothing", async () => {
  const s = await serveOpencode();
  try {
    for (const id of ["openai", "--help", "-x", "Kimi", "a%20b", "x".repeat(65), "..", "a;b"]) {
      const res = await s.post(`/api/setup/opencode/providers/${id}/signin`, {});
      assert.equal(res.status, 404, id);
      // fetch folds ".." away, so the router answers that one before the handler.
      const error = ((await res.json()) as { error: string }).error;
      assert.equal(error, id === ".." ? "not_found" : "unknown_provider", id);
    }
    assert.deepEqual(s.runs, []);
    // Only "openai" passes the regex, so only it reads the set.
    assert.deepEqual(await s.fake.calls(), ["auth list --format json --standalone"]);
  } finally {
    await s.close();
  }
});

test("OpenCode update runs `opencode upgrade`; install gives the installer to copy and runs nothing", async () => {
  const s = await serveOpencode();
  try {
    const install = await s.post("/api/harnesses/opencode/install", {});
    assert.equal(install.status, 200);
    const job = (await install.json()) as Record<string, unknown>;
    assert.equal(job.state, "failed");
    assert.equal(job.command, "curl -fsSL https://opencode.ai/install | bash");
    assert.equal(job.manual, "curl -fsSL https://opencode.ai/install | bash");
    assert.deepEqual(s.runs, []);
    assert.equal((await s.post("/api/harnesses/opencode/signin", {})).status, 404);
    const update = await s.post("/api/harnesses/opencode/update", {});
    assert.equal(update.status, 200);
    assert.equal(((await update.json()) as { command: string }).command, "opencode upgrade");
    assert.deepEqual(s.runs, [`${s.fake.bin} upgrade`]);
  } finally {
    await s.close();
  }
});
