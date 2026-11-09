import { B as ThreadFact, D as Decision, E as ChannelRef, H as ThreadRef, J as TriggerDisposition, S as AdmissionCell, U as Ticket, _ as Repositories, a as ReceiveResult, g as ReplyStatus, n as Deployment, p as OutboundMessage, q as Trigger, v as ScopeResult, y as SourceScope, z as Thread } from "./deployment-DhhCwOYO.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/infra/commands.d.ts
interface Tally {
  skipped: number;
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
declare class Commands {
  private readonly resolved;
  private readonly environment;
  private readonly signal;
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(resolved: () => Deployment, environment: Record<string, string | undefined>, signal: AbortSignal);
  get deployment(): Deployment;
  get repository(): string;
  withSignal(signal?: AbortSignal): Commands;
  run(program: string, args: string[], cwd?: string): Promise<string>;
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  gh<T>(args: string[]): Promise<T>;
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>;
  api(path: string, ...flags: string[]): Promise<string>;
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>;
  private path;
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  lark<T>(args: string[], cwd?: string): Promise<T>;
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  git(args: string[], cwd: string): Promise<string>;
}
//#endregion
//#region src/admission.d.ts
declare const ADMISSION_OPTIONS: {
  readonly listedUnaddressed: readonly ["inferred", "ignore"];
  readonly unlistedAddressed: readonly ["explicit", "inferred", "ignore"];
  readonly unlistedUnaddressed: readonly ["inferred", "ignore"];
};
type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number]; };
//#endregion
//#region src/sources/kind.d.ts
interface Localized {
  zh: string;
  en: string;
}
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase {
  key: string;
  label: Localized;
  hint?: Localized;
  advanced?: true;
}
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
type FieldSpec = FieldBase & {
  type: 'switch';
} | FieldBase & {
  type: 'select';
  options: {
    value: string;
    label: Localized;
  }[];
} | FieldBase & {
  type: 'number';
  min: number;
  max: number;
} | FieldBase & {
  type: 'text';
  pattern?: string;
  readonly?: boolean;
  choose?: Localized;
} | FieldBase & {
  type: 'fact';
  settings?: 'deployment';
} | FieldBase & {
  type: 'rows';
  columns: ({
    key: string;
    label: Localized;
    type: 'text';
    pattern?: string;
    optional?: boolean;
    choose?: Localized;
    refresh?: Localized;
  } | {
    key: string;
    label: Localized;
    type: 'select';
    options: {
      value: string;
      label: Localized;
    }[];
  })[];
};
interface VariableSpec {
  key: string;
  description: Localized;
}
interface EnvironmentInput<C> {
  deployment: Deployment;
  config: C;
  trigger?: Trigger;
}
interface AdmissionRowView {
  id: string;
  label: Localized | string;
  note: Localized;
  cells: {
    listedUnaddressed: boolean;
    unlistedAddressed: boolean;
    unlistedUnaddressed: boolean;
  };
}
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>;
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[];
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: Localized;
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  unnamed?: {
    person: Localized;
    bot: Localized;
  };
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[];
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: {
    label: Localized;
    ready(part: P): boolean;
    run(host: SourceHost, part: P, signal: AbortSignal): Promise<P>;
  };
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
interface ChannelLink {
  url: string;
  label: Localized;
  triggerId?: string;
}
type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>;
/** Outbound messaging adapter for a source kind's threads. */
interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean;
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink;
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
interface ContextMessage {
  id: string;
  from: string;
  at: string;
  text: string;
  bot?: true;
  deleted?: true;
  reply_to?: string;
  url?: string;
  path?: string;
  line?: number;
}
type ContextPartName = 'thread' | 'root' | 'parent';
interface ContextPart {
  messages: ContextMessage[];
  next?: string | undefined;
  body: Record<string, unknown>;
  status?: string;
}
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string;
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>;
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  images?(text: string): string[];
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
interface TriggerContext {
  readonly messageId: string;
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>;
  images(text: string): string[];
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string;
  title: Localized;
  description: Localized;
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>;
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>;
  fields: FieldSpec[];
  /** Health entry names owned by this kind under `health[...]`; no other kind or core loop may report them. */
  health: string[];
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: {
    meta: Record<string, unknown>;
  }, config: C): ScopeResult;
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>;
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>;
  /** Maps a search query to candidate Thread keys (such as `github:12`) and Trigger search terms (such as a Feishu `om_` ID). */
  find?(query: string): {
    threads: string[];
    terms: string[];
  };
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined;
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart<Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>;
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: {
    variables: readonly VariableSpec[];
    values(input: EnvironmentInput<C>): Record<string, string>;
  };
}
interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: string;
  enabled: boolean;
  config: C;
}
//#endregion
//#region src/policy.d.ts
declare const RoleModelSchema: z.ZodObject<{
  provider: z.ZodString;
  model: z.ZodString;
  reasoningEffort: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
type RoleModel = z.infer<typeof RoleModelSchema>;
declare const SettingsSchema: z.ZodObject<{
  paused: z.ZodDefault<z.ZodBoolean>;
  sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strict>>>;
  policy: z.ZodDefault<z.ZodObject<{
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
      id: z.ZodString;
      name: z.ZodString;
      enabled: z.ZodBoolean;
      instruction: z.ZodString;
    }, z.core.$strict>>>;
    sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
      allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
      }, z.core.$strict>>>;
      admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>;
  }, z.core.$strict>>;
  eval: z.ZodDefault<z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
      off: "off";
      observe: "observe";
      auto: "auto";
    }>>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
  }, z.core.$strict>>;
  executor: z.ZodDefault<z.ZodObject<{
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    maxWorkers: z.ZodDefault<z.ZodNumber>;
    directory: z.ZodDefault<z.ZodString>;
    prepare: z.ZodDefault<z.ZodString>;
    blockedCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
  }, z.core.$strict>>;
}, z.core.$strict>;
type Settings = z.infer<typeof SettingsSchema>;
type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`;
type SettingsSave = SettingsBlock | 'pause';
type SettingsOrigin = 'panel' | 'tool' | 'sync';
//#endregion
//#region src/sources/registry.d.ts
/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
declare class SourceRegistry implements SourceScope {
  private readonly settings;
  private readonly board;
  private readonly registered;
  private readonly kinds;
  private readonly health;
  constructor(settings: () => Settings, board?: Pick<HealthBoard, 'claim'>, registered?: (kind: SourceKind) => () => void);
  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void;
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry>;
  kind(id: string): SourceKind | undefined;
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): (SourceInstance & {
    installed: boolean;
  })[];
  instance<C extends Record<string, unknown>>(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): SourceInstance<C> | undefined;
  validate(id: string, value: {
    enabled: boolean;
    config: unknown;
  }): {
    enabled: boolean;
    config: Record<string, unknown>;
  };
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  policyPart(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    admission: Record<string, AdmissionRow>;
    allowed: {
      id: string;
      name?: string;
    }[];
  } | undefined;
  channelAllowed(channel: {
    source: string;
    address: Record<string, string>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): boolean;
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): {
    kind: string;
    variables: readonly VariableSpec[];
  }[];
  environments(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    kind: SourceKind<Record<string, unknown>>;
    environment: {
      variables: readonly VariableSpec[];
      values(input: EnvironmentInput<Record<string, unknown>>): Record<string, string>;
    };
    config: Record<string, unknown>;
  }[];
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'>;
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink;
  find(query: string): {
    threads: string[];
    terms: string[];
  };
  repliesTo(trigger: Trigger): string | undefined;
  threadContext(trigger: Trigger, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): TriggerContext | undefined;
  scope(input: {
    source: string;
    meta: Record<string, unknown>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): ScopeResult;
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve;
}
//#endregion
//#region src/setup.d.ts
type SetupPlace = 'deployment' | 'github' | 'feishu';
declare const SETUP_PROBLEMS: {
  readonly foreignFile: readonly ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."];
  readonly gitTooOld: readonly ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."];
  readonly environmentFailed: readonly ["deployment", "Preparing the agent environment failed."];
  readonly repositoryUnset: readonly ["github", "The GitHub Source names no repository."];
  readonly agentCliUnset: readonly ["github", "The agent GitHub CLI is not set."];
  readonly agentCliMissing: readonly ["github", "The agent GitHub CLI was not found."];
  readonly agentCliSignedOut: readonly ["github", "The agent GitHub CLI cannot read its account."];
  readonly agentCliNoAccount: readonly ["github", "The agent GitHub CLI did not report a GitHub account."];
  readonly repositoryUnreadable: readonly ["github", "@{account} cannot read {repository}."];
  readonly repositoryUnreported: readonly ["github", "The agent GitHub CLI did not return {repository}."];
  readonly repositoryReadOnly: readonly ["github", "@{account} cannot push to {repository}."];
  readonly feishuCliFailed: readonly ["feishu", "The bot lark-cli does not work."];
  readonly feishuNoApp: readonly ["feishu", "auth status of the bot lark-cli did not report the app."];
  readonly feishuBotNotReady: readonly ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."];
  readonly feishuUserIdentity: readonly ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes."];
  readonly feishuNoBot: readonly ["feishu", "The Feishu bot API did not return the bot's open_id."];
};
type SetupCode = keyof typeof SETUP_PROBLEMS;
interface SetupProblem {
  place: SetupPlace;
  code: SetupCode;
  values: Record<string, string>;
  detail: string;
}
//#endregion
//#region src/app/execution-environment.d.ts
interface Variable {
  key: string;
  value: string;
  description: Localized;
  owner: string;
}
//#endregion
//#region src/app/retry-health.d.ts
interface BudgetRetryStatus {
  sessionId: string;
  provider: string;
  attempts: number;
  since: string;
  lastAt: string;
}
//#endregion
//#region src/app/store-read.d.ts
declare function storeReads(db: DatabaseSync): {
  /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
  recentTriggers: (offset?: number, limit?: number) => Trigger[];
  /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
  triggerStats: (since: string) => Record<string, {
    received: number;
    filtered: number;
    lastAt: string;
  }>;
  /**
   * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
   * and how many accept/reopen decisions those same arrivals produced.
   */
  flow: (since: string) => {
    judged: number;
    accepted: number;
  };
  triggers: (options: {
    source?: string;
    filtered?: boolean;
  }, offset?: number, limit?: number) => {
    items: Trigger[];
    more: boolean;
  };
  /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
  threadTriggers: (threadKeyValue: string, limit?: number, before?: TimelinePlace, through?: boolean) => Trigger[];
  threadPage: (threadKeyValue: string, offset: number, limit: number) => Trigger[];
  /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
  neighbours: (threadKeyValue: string, at: string, id: string) => {
    before?: Trigger;
    after?: Trigger;
  };
  /** Oldest trigger on a thread, used to title the thread in listings. */
  firstTrigger: (threadKeyValue: string, humanOnly?: boolean) => Trigger | undefined;
  search: (query: string, limit?: number) => Trigger[];
  recentDecisions: (offset?: number, limit?: number) => Decision[];
  /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
  decisions: (options: {
    kinds: string[];
    since: string;
  }, offset: number, limit: number) => {
    items: Decision[];
    more: boolean;
  };
  /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
  decisionsOfKinds: (kinds: string[], limit?: number) => Decision[];
  /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
  failingReplies: () => (Receipt & {
    attempts: number;
    error: string;
  })[];
  droppedReplies: (limit?: number) => Dropped[];
  droppedSince: (since: string) => number;
  subscribedThreads: (source?: string) => Thread[];
};
//#endregion
//#region src/app/store.d.ts
/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
interface TimelinePlace {
  at: string;
  id: string;
}
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
type DropReason = 'channelGone' | 'channelIgnored';
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
interface Receipt extends OutboundMessage {
  status: ReplyStatus;
  dropped?: {
    at: string;
    reason: DropReason;
  };
}
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
type Dropped = Receipt & {
  dropped: {
    at: string;
    reason: DropReason;
  };
};
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
interface SettingsVersion {
  revision: number;
  savedAt: string;
  source: SettingsOrigin | 'internal';
  block?: SettingsSave;
  policyVersion: string;
  policyChanged: boolean;
  notified: string[];
  settings: Settings;
}
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
declare class Store implements Repositories {
  private readonly report;
  readonly db: DatabaseSync;
  /**
   * Opens or creates the SQLite database at `path`, migrating schema 10 to schema 11 in a single transaction.
   * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
   * @throws When the database schema is older than `OLDEST_SCHEMA` (10), newer than `SCHEMA_VERSION` (11), or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
   */
  constructor(path: string, report?: (error: unknown) => void);
  /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
  private addColumns;
  /** Closes the underlying SQLite database connection. */
  close(): void;
  /** Parses JSON `value` columns returned by `sql`. */
  private values;
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads;
  private depth;
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed;
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T;
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
   */
  afterCommit(action: () => void): void;
  /** Reads a typed KV record by its key in `KV`. */
  get<V>(name: Key<V>): V | undefined;
  /** Writes a typed KV record under `name`. */
  set<V>(name: Key<V>, value: V): void;
  /** Deletes the KV record at `name`. */
  delete(name: string): void;
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[];
  keys(prefix: string): string[];
  /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
  private readonly settingsVersions;
  /** Current validated settings. */
  settings(): Settings;
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number;
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  saveSettings(value: unknown, record?: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'>): Settings;
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  settingsHistory(limit?: number): SettingsVersion[];
  readonly triggers: {
    get: (id: string) => Trigger | undefined;
    save: (trigger: Trigger) => void;
    disposition: (id: string) => TriggerDisposition | undefined;
    saveDisposition: (id: string, value: TriggerDisposition) => void;
  };
  readonly threads: {
    get: (keyValue: string) => Thread | undefined;
    save: (thread: Thread) => void;
    list: () => Thread[];
    active: () => Thread[];
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (keyValue: string, patch: {
      label?: string;
      url?: string;
      facts?: Record<string, ThreadFact | null>;
    }) => void;
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>) => void;
  };
  readonly tickets: {
    get: (id: string) => Ticket | undefined;
    save: (ticket: Ticket) => void;
    /** Newest first. */
    list: () => Ticket[];
    /** Newest first. */
    open: () => Ticket[];
    /** Newest first. */
    active: () => Ticket[];
  };
  readonly decisions: {
    get: (id: string) => Decision | undefined;
    save: (decision: Decision) => void;
    byThread: (threadKeyValue: string) => Decision[];
  };
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>;
  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined;
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts: {
    get: (id: string) => Receipt | undefined;
    /** Pending message receipts, oldest first. */
    waiting: () => Receipt[];
    /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
    behind: (id: string, failures: number) => boolean;
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage) => boolean;
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: "sent" | DropReason) => void;
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string) => boolean;
  };
}
//#endregion
//#region src/app/tools/tool.d.ts
interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>;
}
//#endregion
//#region src/app/sessions.d.ts
/** Host dependencies used by `Sessions`. */
interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context;
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>;
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>;
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>;
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry;
  readonly masterId: string;
  readonly lifetime: AbortSignal;
  closing(): boolean;
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[];
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[];
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void;
  }
}
/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
declare class Sessions {
  private readonly host;
  private readonly agentDelivery;
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings;
  private readonly retryHealth;
  private readonly ctx;
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(host: SessionsHost);
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void;
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent>;
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  holds(sessionId: string, requestId: string): Promise<boolean>;
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | {
    inject: string;
  }, authorize?: () => void, accepted?: () => void): Promise<void>;
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId;
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void;
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void;
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  delivery(name: string): Promise<'injected' | 'pending'>;
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private inject;
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status(): {
    revision: number;
    sessions: {
      sessionId: string;
      revision: number;
    }[];
    notificationPending: boolean;
  };
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion;
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean;
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool;
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined): {
    model_retry: BudgetRetryStatus;
  } | {
    model_retry?: undefined;
  };
  private updateModelHealth;
  private ticketOf;
  private decorate;
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed;
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly;
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent;
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills;
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor;
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release;
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void;
}
//#endregion
//#region src/app/prompts.d.ts
/**
 * A configuration, whose overrides may name a part a later version no longer has, which `Prompts.validate` drops when the
 * saved version holds it and refuses otherwise.
 */
declare const PromptConfigSchema: z.ZodObject<{
  communication: z.ZodString;
  scope: z.ZodString;
  delivery: z.ZodString;
  skills: z.ZodRecord<z.ZodString, z.ZodString>;
  overrides: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
    text: z.ZodString;
    base: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>>;
}, z.core.$strict>;
type PromptConfig = z.infer<typeof PromptConfigSchema>;
interface PromptVersion {
  revision: number;
  previousRevision: number | null;
  savedAt: string;
  source: string;
  config: PromptConfig;
  /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
  legacy?: {
    config: unknown;
  };
}
type Role = 'orchestrator' | 'worker';
/** An override whose built-in text changed since its `base`, with that text when kept, or whose part this version no longer has. */
interface DefaultChange {
  part: string;
  base?: string;
  previous?: string;
  removed?: true;
}
/**
 * Stores numbered prompt configurations in `Store` via `Versions` and composes role system prompts and skills with the execution environment.
 * `Sessions` reads the composed prompts and skills for orchestrator and worker runs, while management routes and tools validate, preview, and save revisions through it.
 */
declare class Prompts {
  private readonly store;
  private readonly maxChars;
  private readonly environment;
  private readonly feishu;
  private readonly versions;
  constructor(store: Store, maxChars: () => number, environment: () => Variable[] | undefined, feishu: () => boolean);
  /** A role's prompt; the main Session's Policy section follows the settings as they are now, at each model request. */
  compose(config: PromptConfig, role: Role, variables?: Variable[] | undefined): string;
  /** Returns skills to register in every Session: built-in Source skills (`feishu` only when a Feishu bot is configured) followed by team skills. */
  skills(config: PromptConfig): [string, string][];
  current(): PromptVersion;
  /** Reads a revision by number; revision 0 resolves to built-in defaults before the first save persists it. */
  version(revision: number): PromptVersion;
  /**
   * Parse a configuration: an override names a built-in part, holds text and keeps its template's placeholders, and records the
   * built-in text it was edited from: the saved override's unless it names one, else the current one. It goes once its text is
   * the built-in text again, and so does one of a part this version no longer has, which the saved version holds.
   */
  validate(value: unknown): PromptConfig;
  /**
   * The overrides of `config` whose built-in part changed since the team edited it, by the `base` they were edited from, each
   * with the built-in text of that base when this installation kept it, and those of a part this version no longer has.
   */
  defaultChanged(config: PromptConfig): DefaultChange[];
  preview(value: unknown): {
    orchestrator: string;
    worker: string;
    parts: {
      orchestrator: ({
        name: string;
        kind: "fixed";
        key: string;
        text: string;
      } | {
        name: "communication" | "scope" | "delivery";
        kind: "team";
        heading: string;
        text: string;
      } | {
        name: string;
        kind: "generated";
        key: string;
        text: string;
      })[];
      worker: ({
        name: string;
        kind: "fixed";
        key: string;
        text: string;
      } | {
        name: "communication" | "scope" | "delivery";
        kind: "team";
        heading: string;
        text: string;
      } | {
        name: string;
        kind: "generated";
        key: string;
        text: string;
      })[];
    };
    skills: {
      [k: string]: string;
    };
    scope: string;
  };
  save(value: unknown, baseRevision: number, source: SettingsOrigin): PromptVersion;
  history(offset?: number, limit?: number): {
    revisions: {
      changed: string[];
      revision: number;
      previousRevision: number | null;
      savedAt: string;
      source: string;
      /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
      legacy?: {
        config: unknown;
      };
    }[];
    next_offset: number | null;
  };
}
//#endregion
//#region src/sources/github-pull.d.ts
declare const PullSchema: z.ZodObject<{
  title: z.ZodOptional<z.ZodString>;
  state: z.ZodString;
  html_url: z.ZodString;
  user: z.ZodPipe<z.ZodNullable<z.ZodObject<{
    login: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>, z.ZodTransform<{
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  }, {
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  } | null>>;
  body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  created_at: z.ZodOptional<z.ZodString>;
  merged: z.ZodOptional<z.ZodBoolean>;
  merged_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  closed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  auto_merge: z.ZodOptional<z.ZodUnknown>;
  head: z.ZodObject<{
    sha: z.ZodString;
    ref: z.ZodString;
    repo: z.ZodOptional<z.ZodNullable<z.ZodObject<{
      full_name: z.ZodString;
    }, z.core.$loose>>>;
  }, z.core.$loose>;
}, z.core.$loose>;
type Pull = z.infer<typeof PullSchema> & {
  number: number;
};
//#endregion
//#region src/sources/github-trigger.d.ts
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
declare const CommentSchema: z.ZodObject<{
  id: z.ZodNumber;
  body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  user: z.ZodPipe<z.ZodNullable<z.ZodObject<{
    login: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>, z.ZodTransform<{
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  }, {
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  } | null>>;
  html_url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  created_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  updated_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  submitted_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  commit_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  line: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  original_line: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  diff_hunk: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  in_reply_to_id: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$loose>;
type GithubComment = z.infer<typeof CommentSchema>;
interface PullRef {
  number: number;
  isPr: boolean;
  url?: string;
  prAuthor?: string;
}
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
declare function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger;
//#endregion
//#region src/sources/github.d.ts
declare const GithubConfigSchema: z.ZodObject<{
  repository: z.ZodDefault<z.ZodString>;
  cli: z.ZodDefault<z.ZodString>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  observeIssues: z.ZodDefault<z.ZodBoolean>;
  observePulls: z.ZodDefault<z.ZodBoolean>;
  observeComments: z.ZodDefault<z.ZodBoolean>;
  observeCi: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
type GithubConfig = z.infer<typeof GithubConfigSchema>;
declare const githubKind: SourceKind<GithubConfig>;
declare const name = "dsh-superagent-github";
declare const inject: string[];
declare function apply(ctx: Context): void;
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
declare function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined;
interface Round {
  started: string;
  signal?: AbortSignal | undefined;
  pulls: Map<number, Promise<Pull>>;
  read: Set<number>;
  failures: string[];
  dropped: number[];
  abandoned: number[];
  tally: Tally;
}
interface Retry {
  since: string;
  pr: boolean;
  failedAt?: string;
  attempts?: number;
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
declare function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number>;
declare function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
declare function pollThreads(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
//#endregion
//#region src/kv.d.ts
/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
type Key<V> = string & {
  readonly __value?: V;
};
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & {
  readonly prefix: string;
};
//#endregion
//#region src/sources/host.d.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
declare const HEALTH_TEXT: {
  readonly setupPending: "Waiting for the deployment check";
  readonly sourceOff: "Off";
  readonly feishuCliUnset: "The Source is on, and its bot lark-cli is not set";
  readonly feishuBotMissing: "Waiting for the Feishu bot";
  readonly pollFailures: "{count} consecutive failed polls; last: {error}";
};
type HealthCode = keyof typeof HEALTH_TEXT;
type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error';
  detail: string;
  at?: string;
  code?: HealthCode;
  values?: Record<string, string>;
};
interface SourceHost {
  readonly sources: SourceRegistry;
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: {
    kind: string;
    health: readonly string[];
  }): SourceContext;
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
interface ThreadDescription {
  label?: string;
  url?: string;
  facts?: Record<string, ThreadFact | null>;
}
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
interface SourceContext {
  readonly deployment: Deployment;
  readonly commands: Commands;
  readonly ready: Promise<void>;
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean;
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined;
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined;
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>;
  atomic<T>(work: () => T): T;
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: {
    get<V>(key: Key<V>): V | undefined;
    set<V>(key: Key<V>, value: V | undefined): void;
    keys<V>(family: Family<V, never>): Key<V>[];
  };
  threads: {
    get(key: string): Thread | undefined;
    subscribed(source: string): Thread[];
    describe(key: string, description: ThreadDescription): void;
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void;
  };
  tickets: {
    get(id: string): Ticket | undefined;
    /** Open tickets, newest first. */
    open(): Ticket[];
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void;
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void;
  };
  triggers: {
    get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */
    latest(thread: string): Trigger | undefined;
  };
  notify(message: OutboundMessage): void;
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void;
}
//#endregion
//#region src/infra/health.d.ts
interface HealthEntry {
  get(): Health | undefined;
  set(health: Health): void;
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void;
}
/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 */
declare class HealthBoard {
  private readonly entries;
  private readonly claimed;
  claim(name: string, initial?: Health): HealthEntry;
  get all(): Readonly<Record<string, Health>>;
}
//#endregion
//#region src/app/effects.d.ts
/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
 */
declare class Later extends Error {}
interface EffectPayloads {
  /** Build an Eval's candidate card and relay it to the main Session; the key is the Eval ID. */
  assessment: {
    triggerId: string;
  };
  /** Launch a pending Assignment; the key is the Assignment ID. */
  launch: {
    ticketId: string;
    assignmentId: string;
  };
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  delivery: {
    ticketId: string;
  };
  /** Steer a report or a candidate into the main Session; the key is the request ID. */
  relay: {
    text: string;
  };
  /** Inject a notice into the main Session without waking it; the key names what it reports, such as `prompts`. */
  notice: {
    value: Record<string, unknown>;
    summary: string;
  };
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  reply: Record<string, never>;
}
type EffectKind = keyof EffectPayloads;
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>;
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  limit: () => number;
  /** Initial and maximum retry backoff delays, in milliseconds. */
  retry: readonly [number, number];
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  ordered: boolean;
  /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
  quiet: boolean;
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>;
/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
 */
declare class Effects {
  private readonly store;
  private readonly board;
  private readonly now;
  private readonly handlers;
  private readonly health;
  private readonly tasks;
  /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
  private readonly broken;
  private seq;
  private scheduled;
  /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
  private started;
  private stopped;
  constructor(store: Store, board: Pick<HealthBoard, 'claim'>, now?: () => number);
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void;
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options?: Options<K>): void;
  pending(kind: EffectKind, key?: string): boolean;
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  cancel(kind: EffectKind, key: string): void;
  start(): void;
  kick(): void;
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
  idle(kind?: EffectKind): Promise<void>;
  /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
  drain(): Promise<void>;
  private dispatch;
  private run;
  private attempt;
  private failed;
  private report;
}
//#endregion
export { Tally as C, SourceKind as S, commentTrigger as _, SourceContext as a, SourceRegistry as b, apply as c, name as d, pollFailure as f, GithubComment as g, pollTicketPulls as h, HealthEntry as i, githubKind as l, pollThreads as m, Later as n, GithubConfig as o, pollRound as p, HealthBoard as r, Retry as s, Effects as t, inject as u, Sessions as v, RoleModel as x, Store as y };