import {
  type Issue,
  LINEAR_API_KEY_SECRET,
  type SecretSource,
  type WorkflowStateName,
} from "@harnessd/shared";
import { compareByPriority, parseIssue, type RawIssue } from "./parse.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export const MISSING_KEY_MESSAGE = `Linear API key not set. Run "harnessd secrets set ${LINEAR_API_KEY_SECRET}".`;

export type LinearErrorCode =
  | "missing_key"
  | "auth"
  | "rate_limited"
  | "http"
  | "graphql"
  | "network"
  | "not_found"
  | "invalid_response";

export class LinearError extends Error {
  readonly code: LinearErrorCode;
  /** HTTP status, when the error came from a response. */
  readonly status: number | undefined;
  constructor(code: LinearErrorCode, message: string, status?: number) {
    super(message);
    this.name = "LinearError";
    this.code = code;
    this.status = status;
  }
}

export interface LinearClientOptions {
  /** A SecretSource (read as "linear-api-key"), or a function returning the key. */
  apiKey: SecretSource | (() => Promise<string | undefined>);
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  endpoint?: string;
  /** Longest Retry-After the client waits out before giving up. Default 60 s. */
  maxRetryWaitMs?: number;
}

export interface ListReadyOptions {
  teamId: string;
  projectId?: string;
}

interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

const PAGE_SIZE = 50;
const DEFAULT_RETRY_MS = 1_000;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  createdAt
  state { name }
  team { id key }
  labels { nodes { name } }
  projectMilestone { name }
  inverseRelations { nodes { type issue { identifier state { type } } } }
`;

const READY_ISSUES_QUERY = `query ReadyIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: createdAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

const ISSUE_TEAM_QUERY = `query IssueTeam($id: String!) {
  issue(id: $id) { id team { id } }
}`;

const TEAM_STATES_QUERY = `query TeamStates($teamId: String!) {
  team(id: $teamId) { id states(first: 100) { nodes { id name type } } }
}`;

const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id state { name } } }
}`;

const COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Minimal Linear GraphQL client: Ready issues, state moves and comments. */
export class LinearClient {
  #readKey: () => Promise<string | undefined>;
  #key: string | undefined;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #endpoint: string;
  #maxRetryWaitMs: number;
  /** Issue id or key → team id, filled from every issue the client has read. */
  #issueTeams = new Map<string, string>();
  /** Team id → workflow states. */
  #teamStates = new Map<string, WorkflowState[]>();

  constructor(options: LinearClientOptions) {
    const source = options.apiKey;
    this.#readKey = typeof source === "function" ? source : () => source.get(LINEAR_API_KEY_SECRET);
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#endpoint = options.endpoint ?? LINEAR_ENDPOINT;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
  }

  /** Ready issues that nothing unfinished blocks, urgent first, then oldest first. */
  async listReady(options: ListReadyOptions): Promise<Issue[]> {
    const filter: Record<string, unknown> = {
      team: { id: { eq: options.teamId } },
      state: { name: { eqIgnoreCase: "Ready" } },
    };
    if (options.projectId !== undefined) filter.project = { id: { eq: options.projectId } };

    const raws: RawIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.request(READY_ISSUES_QUERY, { filter, first: PAGE_SIZE, after });
      if (!data.issues)
        throw new LinearError("invalid_response", "Linear returned no issues field.");
      raws.push(...data.issues.nodes);
      const { hasNextPage, endCursor } = data.issues.pageInfo;
      if (!hasNextPage || !endCursor) break;
      after = endCursor;
    }

    return raws
      .map((raw) => {
        const issue = this.#remember(raw);
        return { issue, priority: issue.priority, createdAt: raw.createdAt };
      })
      .filter(({ issue }) => issue.blockedBy.length === 0)
      .sort(compareByPriority)
      .map(({ issue }) => issue);
  }

  /** Reads one issue by key ("MET-12") or UUID. */
  async getIssue(keyOrId: string): Promise<Issue> {
    const data: { issue: RawIssue | null } = await this.request(ISSUE_QUERY, { id: keyOrId });
    if (!data.issue) throw new LinearError("not_found", `Linear issue ${keyOrId} not found.`);
    return this.#remember(data.issue);
  }

  /** Moves an issue to a workflow state of its team, matched by name (case-insensitive). */
  async moveTo(issueId: string, stateName: WorkflowStateName): Promise<void> {
    const teamId = await this.#teamOf(issueId);
    const states = await this.#statesOf(teamId);
    const wanted = stateName.toLowerCase();
    const state = states.find((s) => s.name.toLowerCase() === wanted);
    if (!state) {
      const known = states.map((s) => s.name).join(", ");
      throw new LinearError(
        "not_found",
        `Linear team has no workflow state "${stateName}" (has: ${known}).`,
      );
    }
    const data: { issueUpdate: { success: boolean } } = await this.request(ISSUE_UPDATE_MUTATION, {
      id: issueId,
      input: { stateId: state.id },
    });
    if (!data.issueUpdate?.success) {
      throw new LinearError("graphql", `Linear did not move ${issueId} to "${stateName}".`);
    }
  }

  /** Posts a markdown comment; returns the comment id. */
  async comment(issueId: string, body: string): Promise<string> {
    const data: { commentCreate: { success: boolean; comment: { id: string } | null } } =
      await this.request(COMMENT_CREATE_MUTATION, { input: { issueId, body } });
    if (!data.commentCreate?.success || !data.commentCreate.comment) {
      throw new LinearError("graphql", `Linear did not create the comment on ${issueId}.`);
    }
    return data.commentCreate.comment.id;
  }

  /** Sends one GraphQL operation. Retries once on rate limiting, honouring Retry-After. */
  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const key = await this.#apiKey();
    for (let attempt = 0; ; attempt++) {
      const result = await this.#send<T>(key, query, variables);
      if (result.ok) return result.data;
      const error = result.error;
      if (error.code === "auth") this.#key = undefined;
      if (error.code !== "rate_limited" || attempt > 0) throw error;
      const waitMs = result.retryAfterMs ?? DEFAULT_RETRY_MS;
      if (waitMs > this.#maxRetryWaitMs) throw error;
      await this.#sleep(waitMs);
    }
  }

  async #send<T>(
    key: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: LinearError; retryAfterMs?: number }> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: new LinearError("network", `Linear request failed: ${detail}`) };
    }

    const status = response.status;
    let body: { data?: T | null; errors?: GraphQLError[] } | undefined;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = undefined;
    }
    const errors = body?.errors ?? [];
    const codes = errors.map((e) => e.extensions?.code ?? "");

    if (status === 429 || codes.includes("RATELIMITED")) {
      const error = new LinearError("rate_limited", "Linear rate limit hit.", status);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
    }
    if (status === 401 || status === 403 || codes.includes("AUTHENTICATION_ERROR")) {
      return {
        ok: false,
        error: new LinearError(
          "auth",
          `Linear rejected the API key (HTTP ${status}). Check it with "harnessd secrets set ${LINEAR_API_KEY_SECRET}".`,
          status,
        ),
      };
    }
    if (errors.length > 0) {
      const message = errors
        .map((e) => e.extensions?.userPresentableMessage ?? e.message)
        .join("; ");
      return { ok: false, error: new LinearError("graphql", `Linear error: ${message}`, status) };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: new LinearError("http", `Linear request failed with HTTP ${status}.`, status),
      };
    }
    if (!body?.data) {
      return {
        ok: false,
        error: new LinearError("invalid_response", "Linear returned no data.", status),
      };
    }
    return { ok: true, data: body.data };
  }

  async #apiKey(): Promise<string> {
    if (this.#key) return this.#key;
    const key = (await this.#readKey())?.trim();
    if (!key) throw new LinearError("missing_key", MISSING_KEY_MESSAGE);
    this.#key = key;
    return key;
  }

  #remember(raw: RawIssue): Issue {
    const issue = parseIssue(raw);
    if (raw.team?.id) {
      this.#issueTeams.set(issue.id, raw.team.id);
      this.#issueTeams.set(issue.key, raw.team.id);
    }
    return issue;
  }

  async #teamOf(issueId: string): Promise<string> {
    const cached = this.#issueTeams.get(issueId);
    if (cached) return cached;
    const data: { issue: { id: string; team: { id: string } | null } | null } = await this.request(
      ISSUE_TEAM_QUERY,
      { id: issueId },
    );
    const teamId = data.issue?.team?.id;
    if (!teamId) throw new LinearError("not_found", `Linear issue ${issueId} not found.`);
    this.#issueTeams.set(issueId, teamId);
    return teamId;
  }

  async #statesOf(teamId: string): Promise<WorkflowState[]> {
    const cached = this.#teamStates.get(teamId);
    if (cached) return cached;
    const data: { team: { states: { nodes: WorkflowState[] } } | null } = await this.request(
      TEAM_STATES_QUERY,
      { teamId },
    );
    if (!data.team) throw new LinearError("not_found", `Linear team ${teamId} not found.`);
    const states = data.team.states.nodes;
    this.#teamStates.set(teamId, states);
    return states;
  }
}

/** Retry-After as delta-seconds or an HTTP date, in ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
