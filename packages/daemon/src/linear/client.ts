import {
  type BoardIssue,
  type Issue,
  LINEAR_API_KEY_SECRET,
  type LinkedIssue,
  type SecretReader,
  type WorkflowStateName,
} from "@harnessd/shared";
import { Agent, type Dispatcher } from "undici";
import { isNetworkError } from "../net-error.ts";
import {
  compareByPriority,
  compareQueueOrder,
  keyNumber,
  parseIssue,
  parseLinkedIssue,
  type RawIssue,
} from "./parse.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export const MISSING_KEY_MESSAGE =
  "Linear API key not set. Paste it in Settings, Connections, Linear, or set LINEAR_API_KEY.";

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
  /**
   * A SecretReader (read as "linear-api-key"), or a function returning the key. It is read
   * on each request, so a key replaced in Settings applies at once (MET-33).
   */
  apiKey: SecretReader | (() => Promise<string | undefined>);
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  endpoint?: string;
  /** Longest Retry-After the client waits out before giving up. Default 60 s. */
  maxRetryWaitMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Builds a fresh connection pool; a test can count the resets. */
  newDispatcher?: () => Dispatcher;
}

export interface ListReadyOptions {
  /** Team UUID, or the team key ("MET"). */
  teamId: string;
  projectId?: string;
  /** Project name, matched case-insensitively; used when projectId is not set. */
  projectName?: string;
}

/** A new sub-issue: same team and project as the parent. */
export interface CreateSubIssueInput {
  title: string;
  /** Markdown body. */
  description: string;
  state: WorkflowStateName;
  /** Label names to copy from the parent. Names the parent does not carry are an error. */
  labels?: string[];
}

interface ParentMeta {
  teamId: string;
  projectId: string | undefined;
  labels: { id: string; name: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const DEFAULT_TIMEOUT_MS = 30_000;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  sortOrder
  url
  createdAt
  state { name }
  team { id key }
  labels { nodes { name } }
  projectMilestone { name }
  parent { id identifier }
  inverseRelations { nodes { type issue { identifier state { type name } id } } }
`;

const issuesQuery = (
  name: string,
) => `query ${name}($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: createdAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const READY_ISSUES_QUERY = issuesQuery("ReadyIssues");
const BOARD_ISSUES_QUERY = `query BoardIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;
const READY_CONTAINING_QUERY = issuesQuery("ReadyIssuesContaining");

const ISSUE_CHILDREN_QUERY = `query IssueChildren($id: String!) {
  issue(id: $id) { id children(first: 100) { nodes { ${ISSUE_FIELDS} } } }
}`;

const PARENT_META_QUERY = `query IssueParentMeta($id: String!) {
  issue(id: $id) { id team { id } project { id } labels { nodes { id name } } }
}`;

const ISSUE_CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const RELATION_CREATE_MUTATION = `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
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

/** Maps a thrown fetch failure to a network error; an abort is the request timeout. */
function transportError(cause: unknown): LinearError {
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return new LinearError("network", "Linear request timed out");
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new LinearError("network", `Linear request failed: ${detail}`);
}

/** Minimal Linear GraphQL client: Ready issues, sub-issues, relations, state moves and comments. */
export class LinearClient {
  #readKey: () => Promise<string | undefined>;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #endpoint: string;
  #maxRetryWaitMs: number;
  #timeoutMs: number;
  #newDispatcher: () => Dispatcher;
  #dispatcher: Dispatcher;
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
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#newDispatcher = options.newDispatcher ?? (() => new Agent());
    this.#dispatcher = this.#newDispatcher();
  }

  /**
   * Drops the pooled connections, so the next request opens a fresh one (MET-184). The old
   * pool closes in the background. #send calls this after a network error, which heals a
   * dead socket without a daemon restart.
   */
  resetConnections(): void {
    const old = this.#dispatcher;
    this.#dispatcher = this.#newDispatcher();
    void old.close().catch(() => {});
  }

  /** Ready issues that nothing unfinished blocks, in Linear's queue order. */
  async listReady(options: ListReadyOptions): Promise<Issue[]> {
    const raws = await this.#listIssues(READY_ISSUES_QUERY, readyFilter(options));
    return raws
      .map((raw) => {
        const issue = this.#remember(raw);
        return { issue, order: { ...issue, createdAt: raw.createdAt } };
      })
      .filter(({ issue }) => issue.blockedBy.length === 0)
      .sort((a, b) => compareQueueOrder(a.order, b.order))
      .map(({ issue }) => issue);
  }

  /**
   * The board (MET-18): every issue of the team and project that is not canceled, with
   * Done only for the last 7 days. Urgent first, no priority last, then by key number.
   */
  async listBoard(options: ListReadyOptions): Promise<BoardIssue[]> {
    const raws = await this.#listIssues(BOARD_ISSUES_QUERY, boardFilter(options));
    return raws
      .map((raw) => {
        const issue = this.#remember(raw);
        const item: BoardIssue = {
          id: issue.id,
          key: issue.key,
          title: issue.title,
          state: issue.state,
          priority: issue.priority,
          labels: issue.labels,
          url: issue.url,
          blockedBy: issue.blockedBy,
          updatedAt: raw.updatedAt ?? raw.createdAt,
        };
        if (issue.size !== undefined) item.size = issue.size;
        if (raw.parent?.identifier) item.parentKey = raw.parent.identifier;
        return item;
      })
      .sort(compareBoard);
  }

  /**
   * Ready issues whose description contains `text`, blocked ones included, with
   * their parent and blockers. Urgent first, then oldest first.
   */
  async listReadyContaining(options: ListReadyOptions, text: string): Promise<LinkedIssue[]> {
    const filter = { ...readyFilter(options), description: { contains: text } };
    const raws = await this.#listIssues(READY_CONTAINING_QUERY, filter);
    return raws
      .map((raw) => {
        this.#remember(raw);
        const issue = parseLinkedIssue(raw);
        return { issue, priority: issue.priority, createdAt: raw.createdAt };
      })
      .sort(compareByPriority)
      .map(({ issue }) => issue);
  }

  /** The sub-issues of an issue, with their blockers, in creation order. */
  async listChildren(parentId: string): Promise<LinkedIssue[]> {
    const data: { issue: { children: { nodes: RawIssue[] } | null } | null } = await this.request(
      ISSUE_CHILDREN_QUERY,
      { id: parentId },
    );
    if (!data.issue) throw new LinearError("not_found", `Linear issue ${parentId} not found.`);
    return (data.issue.children?.nodes ?? [])
      .slice()
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((raw) => {
        this.#remember(raw);
        return parseLinkedIssue(raw);
      });
  }

  /** Creates a sub-issue of `parentId` in the parent's team and project. */
  async createSubIssue(parentId: string, input: CreateSubIssueInput): Promise<LinkedIssue> {
    const parent = await this.#parentMeta(parentId);
    const labelIds = (input.labels ?? []).map((name) => {
      const label = parent.labels.find((l) => l.name === name);
      if (!label) {
        throw new LinearError("not_found", `Linear issue ${parentId} has no label "${name}".`);
      }
      return label.id;
    });
    const stateId = await this.#stateId(parent.teamId, input.state);
    const create: Record<string, unknown> = {
      teamId: parent.teamId,
      parentId,
      title: input.title,
      description: input.description,
      stateId,
    };
    if (parent.projectId !== undefined) create.projectId = parent.projectId;
    if (labelIds.length > 0) create.labelIds = labelIds;
    const data: { issueCreate: { success: boolean; issue: RawIssue | null } } = await this.request(
      ISSUE_CREATE_MUTATION,
      { input: create },
    );
    if (!data.issueCreate?.success || !data.issueCreate.issue) {
      throw new LinearError("graphql", `Linear did not create the sub-issue of ${parentId}.`);
    }
    this.#remember(data.issueCreate.issue);
    return parseLinkedIssue(data.issueCreate.issue);
  }

  /** Records that `blockerId` blocks `blockedId` (Linear relation type "blocks"). */
  async createBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
    const data: { issueRelationCreate: { success: boolean } } = await this.request(
      RELATION_CREATE_MUTATION,
      { input: { issueId: blockerId, relatedIssueId: blockedId, type: "blocks" } },
    );
    if (!data.issueRelationCreate?.success) {
      throw new LinearError("graphql", `Linear did not relate ${blockerId} to ${blockedId}.`);
    }
  }

  /** Reads one issue by key ("MET-12") or UUID. */
  async getIssue(keyOrId: string): Promise<Issue> {
    const data: { issue: RawIssue | null } = await this.request(ISSUE_QUERY, { id: keyOrId });
    if (!data.issue) throw new LinearError("not_found", `Linear issue ${keyOrId} not found.`);
    return this.#remember(data.issue);
  }

  /** Moves an issue to a workflow state of its team, matched by name (case-insensitive). */
  async moveTo(issueId: string, stateName: WorkflowStateName): Promise<void> {
    const stateId = await this.#stateId(await this.#teamOf(issueId), stateName);
    const data: { issueUpdate: { success: boolean } } = await this.request(ISSUE_UPDATE_MUTATION, {
      id: issueId,
      input: { stateId },
    });
    if (!data.issueUpdate?.success) {
      throw new LinearError("graphql", `Linear did not move ${issueId} to "${stateName}".`);
    }
  }

  /** Replaces an issue's description (markdown body). */
  async updateDescription(issueId: string, description: string): Promise<void> {
    const data: { issueUpdate: { success: boolean } } = await this.request(ISSUE_UPDATE_MUTATION, {
      id: issueId,
      input: { description },
    });
    if (!data.issueUpdate?.success) {
      throw new LinearError("graphql", `Linear did not update the description of ${issueId}.`);
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
        signal: AbortSignal.timeout(this.#timeoutMs),
        // undici's Agent and the dispatcher type Node's fetch declares are the same object at
        // runtime; the two type packages differ only in how they spell compose().
        dispatcher: this.#dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
      });
    } catch (cause) {
      return this.#failed(transportError(cause));
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
      return this.#failed(error, retryAfterMs);
    }
    if (status === 401 || status === 403 || codes.includes("AUTHENTICATION_ERROR")) {
      return this.#failed(
        new LinearError(
          "auth",
          `Linear rejected the API key (HTTP ${status}). Replace it in Settings, Connections, Linear.`,
          status,
        ),
      );
    }
    if (errors.length > 0) {
      const message = errors
        .map((e) => e.extensions?.userPresentableMessage ?? e.message)
        .join("; ");
      return this.#failed(new LinearError("graphql", `Linear error: ${message}`, status));
    }
    if (!response.ok) {
      return this.#failed(
        new LinearError("http", `Linear request failed with HTTP ${status}.`, status),
      );
    }
    if (!body?.data) {
      return this.#failed(new LinearError("invalid_response", "Linear returned no data.", status));
    }
    return { ok: true, data: body.data };
  }

  /** Surfaces a failed request and drops the pool when the failure was in transport. */
  #failed(
    error: LinearError,
    retryAfterMs?: number,
  ): { ok: false; error: LinearError; retryAfterMs?: number } {
    if (isNetworkError(error)) this.resetConnections();
    return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
  }

  async #apiKey(): Promise<string> {
    const key = (await this.#readKey())?.trim();
    if (!key) throw new LinearError("missing_key", MISSING_KEY_MESSAGE);
    return key;
  }

  async #listIssues(query: string, filter: Record<string, unknown>): Promise<RawIssue[]> {
    const raws: RawIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.request(query, { filter, first: PAGE_SIZE, after });
      if (!data.issues)
        throw new LinearError("invalid_response", "Linear returned no issues field.");
      raws.push(...data.issues.nodes);
      const { hasNextPage, endCursor } = data.issues.pageInfo;
      if (!hasNextPage || !endCursor) break;
      after = endCursor;
    }
    return raws;
  }

  async #stateId(teamId: string, stateName: WorkflowStateName): Promise<string> {
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
    return state.id;
  }

  async #parentMeta(parentId: string): Promise<ParentMeta> {
    const data: {
      issue: {
        id: string;
        team: { id: string } | null;
        project: { id: string } | null;
        labels: { nodes: { id: string; name: string }[] } | null;
      } | null;
    } = await this.request(PARENT_META_QUERY, { id: parentId });
    const teamId = data.issue?.team?.id;
    if (!data.issue || !teamId) {
      throw new LinearError("not_found", `Linear issue ${parentId} not found.`);
    }
    this.#issueTeams.set(parentId, teamId);
    return {
      teamId,
      projectId: data.issue.project?.id,
      labels: data.issue.labels?.nodes ?? [],
    };
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

/** Team by UUID or by key; project by id, else by name. Only Ready issues. */
export function readyFilter(options: ListReadyOptions): Record<string, unknown> {
  const team = UUID.test(options.teamId)
    ? { id: { eq: options.teamId } }
    : { key: { eqIgnoreCase: options.teamId } };
  const filter: Record<string, unknown> = {
    team,
    state: { name: { eqIgnoreCase: "Ready" } },
  };
  if (options.projectId !== undefined) filter.project = { id: { eq: options.projectId } };
  else if (options.projectName !== undefined) {
    filter.project = { name: { eqIgnoreCase: options.projectName } };
  }
  return filter;
}

/** The board's filter: team and project, not canceled, Done only for the last 7 days. */
export function boardFilter(options: ListReadyOptions): Record<string, unknown> {
  const { state: _ready, ...scope } = readyFilter(options);
  return {
    ...scope,
    state: { type: { neq: "canceled" } },
    or: [{ state: { type: { neq: "completed" } } }, { completedAt: { gt: "-P7D" } }],
  };
}

/** Urgent (1) to low (4), then no priority (0); then by key number. */
function compareBoard(a: BoardIssue, b: BoardIssue): number {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return rank(a.priority) - rank(b.priority) || keyNumber(a.key) - keyNumber(b.key);
}

/** Retry-After as delta-seconds or an HTTP date, in ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
