import { $ as liveTicket, A as Execution, B as ThreadFact, C as Assignment, D as Decision, E as ChannelRef, F as PolicyEffect, G as TicketInput, H as ThreadRef, I as ReportState, J as TriggerDisposition, K as TicketOutcome, L as Strength, M as FollowupRecords, N as Mandate, O as DecisionKind, P as MandateBasis, Q as latestReport, R as Text, S as AdmissionCell, T as Attention, U as Ticket, V as ThreadFacts, W as TicketEndBy, X as isoTime, Y as followupOwners, Z as latestAssignment, _ as Repositories, a as ReceiveResult, at as ticketOutcome, b as AcceptMode, c as Candidate, ct as Reason, d as Executor, dt as said, et as reached, f as GateResult, g as ReplyStatus, h as Policy, i as Machine, it as threadKey, j as Follow, k as Evaluation, l as DomainEvent, lt as ReasonCode, m as Outbox, nt as runningAssignment, o as AssessmentOutcome, ot as waitsForPerson, p as OutboundMessage, q as Trigger, rt as settled, s as Assessor, st as REASONS, tt as readUntil, u as DomainEvents, ut as reasonText, v as ScopeResult, w as AssignmentState, x as ActorRef, y as SourceScope, z as Thread } from "./deployment-DhhCwOYO.js";
import { _ as Reply, a as MemoryRepositories, c as UserErrorCode, d as EngineForMainSession, f as EngineForPeople, g as WorkerReport, h as Outcome, i as ticketStage, l as Engine, m as EngineForSources, n as TicketStage, o as USER_ERRORS, p as EngineForSettings, r as canRetry, s as UserError, t as key, u as EngineForExecutor, v as ReplyRequest, y as EngineOptions } from "./ids-DePfPs6k.js";
import { i as HealthEntry, n as Later, r as HealthBoard, t as Effects, v as Sessions, x as RoleModel, y as Store } from "./effects-BCGqoAhx.js";
import { Context } from "@deepseek-ai/cordis";
import { ContextFormed, MessageId } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-subprocess";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/company-environment.d.ts
interface Variable {
  key: string;
  value: string;
  description: string | {
    zh: string;
    en: string;
  };
  owner: string;
}
//#endregion
//#region src/executor/dsh.d.ts
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
declare const workerSessionId: (ticketId: string) => string;
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
declare const ticketOfSession: (sessionId: string) => string | undefined;
/** Host dependencies used by `DshExecutor`. */
interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context;
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report' | 'assignmentInterrupted'>;
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>;
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>;
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry;
  readonly machine: Pick<Machine, 'stateDir'>;
  readonly lifetime: AbortSignal;
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>;
  closing(): boolean;
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean;
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[];
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{
    source_url?: string;
    source_url_read?: string;
  }>;
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined;
}
/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
declare function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string;
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
declare class WorkerSlots {
  private readonly running;
  private readonly max;
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting;
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(running: () => string[], max: () => number);
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number;
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number;
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void;
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void;
}
/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
declare class DshExecutor implements Executor {
  private readonly host;
  private readonly disposers;
  private readonly slots;
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient;
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming;
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling;
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping;
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left;
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal;
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers;
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(host: ExecutorHost);
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, {
    kind: 'accept';
  }>): Ticket;
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private prepareDirectory;
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void;
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void;
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private launchQueued;
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private deliverQueued;
  private deliverInput;
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private triggerCard;
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void;
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork;
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track;
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private stopped;
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  shutdown(): Promise<void>;
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number;
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running;
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed;
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed;
  private relay;
  private launch;
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf;
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void;
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void;
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void;
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background;
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries;
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter;
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after;
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff;
  private workerIdle;
}
//#endregion
//#region src/app/delivery.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': {
      kind: 'dsh-superagent';
    } & ContextFormed;
  }
}
/** The id of the message delivered under `requestId`, the same on every retry. */
declare const messageId: (requestId: string) => MessageId;
/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
declare class AgentDelivery {
  private readonly ctx;
  private readonly seen;
  constructor(ctx: Context);
  private history;
  holds(agent: Agent, requestId: string): Promise<boolean>;
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | {
    inject: string;
  }, signal: AbortSignal, authorize?: () => void, accepted?: () => void): Promise<void>;
}
//#endregion
//#region src/app/role-models.d.ts
/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
declare function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void>;
//#endregion
export { AcceptMode, ActorRef, AdmissionCell, AgentDelivery, AssessmentOutcome, Assessor, Assignment, AssignmentState, Attention, Candidate, ChannelRef, Decision, DecisionKind, DomainEvent, DomainEvents, DshExecutor, Effects, Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources, type EngineOptions, Evaluation, Execution, Executor, Follow, FollowupRecords, GateResult, HealthBoard, Later, Mandate, MandateBasis, MemoryRepositories, OutboundMessage, Outbox, type Outcome, Policy, PolicyEffect, REASONS, type Reason, type ReasonCode, type ReceiveResult, type Reply, type ReplyRequest, ReplyStatus, ReportState, Repositories, ScopeResult, SourceScope, Strength, Text, Thread, ThreadFact, ThreadFacts, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome, type TicketStage, Trigger, TriggerDisposition, USER_ERRORS, UserError, type UserErrorCode, type WorkerReport, WorkerSlots, canRetry, followupOwners, initializeRoleModel, isoTime, key, latestAssignment, latestReport, liveTicket, mandateInstructions, messageId, reached, readUntil, reasonText, runningAssignment, said, settled, threadKey, ticketOfSession, ticketOutcome, ticketStage, waitsForPerson, workerSessionId };