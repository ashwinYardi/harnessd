import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startDaemon } from "../server/daemon.ts";
import type { Check } from "../status/status.ts";
import { type SetupOptions, setupRoutes } from "./routes.ts";

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
    platform: "darwin",
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
      ],
    );
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

test("Sign in opens Terminal on macOS with the CLI's login command", async () => {
  const s = await serve();
  try {
    const res = await s.post("/api/harnesses/claude-code/signin", {});
    assert.equal(res.status, 200);
    assert.deepEqual(s.runs, [
      'osascript -e tell application "Terminal" to do script "claude auth login" -e tell application "Terminal" to activate',
    ]);
  } finally {
    await s.close();
  }
  const linux = await serve({ platform: "linux" });
  try {
    const res = await linux.post("/api/harnesses/claude-code/signin", {});
    assert.equal(res.status, 400);
    assert.match(
      ((await res.json()) as { message: string }).message,
      /Run claude auth login in a terminal/,
    );
    assert.deepEqual(linux.runs, []);
  } finally {
    await linux.close();
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
