import { a as latestReport, c as readUntil, d as threadKey, f as ticketOutcome, i as latestAssignment, l as runningAssignment, n as followupOwners, o as liveTicket, p as waitsForPerson, r as isoTime, s as reached, t as key, u as settled } from "./ids-BRt74PNv.js";
import { dirname, join } from "node:path";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { MessageId, ReasoningEffortId, freezeMessage } from "@deepseek-ai/dsh-llm";
//#region src/core/errors.ts
/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
const USER_ERRORS = {
	unknownTicket: ["missing", "Unknown ticket"],
	unknownProblem: ["missing", "Unavailable Eval not found"],
	unknownTrigger: ["missing", "Unknown trigger"],
	unknownAssignment: ["missing", "Unknown assignment"],
	unknownBlock: ["missing", "Unknown settings block: {block}"],
	unknownPromptRevision: ["missing", "Unknown prompt revision {revision}"],
	unknownPromptPart: ["refused", "Unknown built-in prompt part {part}"],
	ticketEnded: ["refused", "Ticket has ended"],
	assignmentEnded: ["refused", "Assignment has ended; a newer assignment owns this ticket"],
	evalFinished: ["refused", "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"],
	notAdmissible: ["refused", "Trigger is not admissible: {reason}"],
	notExplicit: ["refused", "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide"],
	ticketStopped: ["refused", "A person stopped this ticket; new work needs an accept through orchestrator_route"],
	mandateRevoked: ["refused", "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"],
	notRetryable: ["refused", "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"],
	sourceThread: ["refused", "This is the thread the ticket started on; it stays subscribed"],
	followedThread: ["refused", "This thread is the ticket's own, such as its pull request's; it stays subscribed"],
	notFollowing: ["refused", "This ticket does not follow that thread"],
	questionWithResult: ["refused", "A question for a person cannot also be a ready result or an answer; report it separately"],
	askerWithoutQuestion: ["refused", "The message that raised a question needs the question it raised"],
	notAsker: ["refused", "A question must name the person's message that raised it, which reached this ticket"],
	notAnswerable: ["refused", "An answer must name the person's question it answers, which reached this ticket"],
	ackEnded: ["refused", "Ticket ended; do not acknowledge historical requests"],
	notReached: ["refused", "Trigger does not belong to this worker"],
	handedBack: ["refused", "This ticket handed that trigger back already"],
	handedBackHere: ["refused", "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"],
	workerDecides: ["refused", "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop"],
	ackNoChannel: ["refused", "Acknowledgement requires an assigned human source message"],
	ackNotPerson: ["refused", "Use the original human trigger, not a bot, CI or worker report"],
	notReady: ["refused", "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."],
	notAttention: ["refused", "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."],
	notQuestion: ["refused", "An answer must target the original human question, not a worker report or automated trigger"],
	noAnswer: ["refused", "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."],
	noChannel: ["refused", "No reply channel for this ticket or trigger"],
	panelOnlyEnvironment: ["refused", "The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel"],
	panelOnlyAccounts: ["refused", "Source fields that setup reads, such as account CLIs, can only be changed in the management panel"],
	setupComplete: ["refused", "Setup is complete"],
	modelUnavailable: ["refused", "The {block} model is not available: {error}"],
	promptTooLong: ["refused", "Prompt configuration exceeds {limit} characters"],
	promptPlaceholders: ["refused", "The “{part}” template must keep {placeholders}, which the system fills in"],
	promptPartEmpty: ["refused", "The “{part}” part cannot be empty; reset it to follow its built-in text"],
	sourceNotInstalled: ["refused", "The {source} Source kind is not installed"],
	noLabels: ["refused", "This Source has no names to refresh"],
	nothingToSync: ["refused", "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup"]
};
/**
* Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
* Tool handlers and HTTP routes inspect its code and missing flag to return appropriate status responses, while the web panel localizes the code.
*/
var UserError = class extends Error {
	code;
	values;
	missing;
	constructor(code, values = {}) {
		const [kind, text] = USER_ERRORS[code];
		super(text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match));
		this.code = code;
		this.values = values;
		this.missing = kind === "missing";
	}
};
//#endregion
//#region src/core/part.ts
/** Shared base class and configuration for Engine domain parts. */
/**
* Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
* Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
*/
var EnginePart = class {
	options;
	repo;
	constructor(options) {
		this.options = options;
		this.repo = options.repo;
	}
	now() {
		return this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
	}
	policy() {
		return this.options.policy();
	}
	/** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
	owners(trigger) {
		return followupOwners(trigger, this.repo);
	}
	/** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
	leftToWorkers(trigger) {
		const owners = this.owners(trigger);
		if (owners.length) throw new UserError("workerDecides", { tickets: owners.join(", ") });
	}
	/**
	* Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
	* ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
	* Eval or one on a Thread it follows for context, went to Eval without it.
	* @returns whether it was queued.
	*/
	handBack(ticketId, trigger, reason) {
		const decided = this.owners(trigger).includes(ticketId);
		const disposition = this.repo.triggers.disposition(trigger.id) ?? {
			fanout: [],
			at: this.now()
		};
		const handbacks = [...disposition.handbacks ?? [], {
			ticketId,
			reason,
			at: this.now()
		}];
		this.repo.triggers.saveDisposition(trigger.id, {
			...disposition,
			handbacks
		});
		return decided && !this.owners(trigger).length && this.queueForEval(trigger);
	}
	/** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
	takeUp(ticketId, triggerId) {
		const disposition = this.repo.triggers.disposition(triggerId);
		if (disposition && !disposition.acked?.includes(ticketId)) this.repo.triggers.saveDisposition(triggerId, {
			...disposition,
			acked: [...disposition.acked ?? [], ticketId]
		});
	}
	/** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
	queueForEval(trigger) {
		const primary = this.thread(trigger.threads[0]);
		if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false;
		primary.pending.push(trigger.id);
		this.repo.threads.save(primary);
		return true;
	}
	emit(type, data) {
		this.options.emit?.({
			type,
			at: this.now(),
			data
		});
	}
	require(ticketId) {
		const ticket = this.repo.tickets.get(ticketId);
		if (!ticket) throw new UserError("unknownTicket");
		return ticket;
	}
	/** Returns the stored Thread or an unsaved empty Thread aggregate. */
	thread(ref) {
		const k = threadKey(ref);
		return this.repo.threads.get(k) ?? {
			key: k,
			ref: {
				source: ref.source,
				id: ref.id
			},
			createdAt: this.now(),
			subscriptions: [],
			correlated: [],
			pending: [],
			meta: {}
		};
	}
	ticketsOnThread(thread) {
		return thread.subscriptions.flatMap((id) => {
			const ticket = this.repo.tickets.get(id);
			return ticket ? [ticket] : [];
		});
	}
	source(ticket) {
		return this.repo.triggers.get(ticket.origin.triggerId);
	}
	reaches(ticket, trigger, context = true) {
		return reached(ticket, trigger, (k) => this.repo.threads.get(k), context);
	}
};
//#endregion
//#region src/core/stage.ts
/** Ticket stage classification and retry eligibility (docs/003). */
/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
function ticketStage(ticket) {
	if (ticket.ended) return { stage: "ended" };
	if (ticket.delivery) return {
		stage: "person",
		action: "delivery"
	};
	if (ticket.attention) return {
		stage: "person",
		action: "answer"
	};
	const assignment = latestAssignment(ticket);
	const report = assignment?.report?.state;
	if (report === "ready") return {
		stage: "person",
		action: "review"
	};
	if ((report === "blocked" || report === "failed") && waitsForPerson(ticket)) return {
		stage: "person",
		action: report
	};
	if (!assignment || assignment.state === "pending") return {
		stage: "working",
		action: "queued"
	};
	if (report === "waiting" || assignment.state === "ended") return { stage: "idle" };
	return { stage: "working" };
}
/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
function canRetry(ticket) {
	return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery);
}
//#endregion
//#region src/core/tickets.ts
/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
const sameChannel = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
const automatic = (input) => input?.kind === "note" || input?.kind === "trigger" && !input.human;
/**
* Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
* into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
*/
const readBefore = (input, until) => input.readAt === void 0 ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until;
const STATUS_REQUEST = "Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.";
/**
* Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
* Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
* Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
* Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
*/
var Tickets = class extends EnginePart {
	replies;
	constructor(options, replies) {
		super(options);
		this.replies = replies;
	}
	/**
	* Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
	* Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
	* gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
	*/
	create(id, decisionId, mandate, evaluation, outcome, at) {
		const { triggerIds } = evaluation;
		const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1));
		const origin = {
			triggerId: primary?.id ?? triggerIds[0],
			triggerIds
		};
		let ticket = {
			id,
			title: outcome.title,
			decisionId,
			mandate,
			channels: [],
			assignments: [],
			inputs: [],
			undelivered: [],
			createdAt: at,
			updatedAt: at,
			origin
		};
		for (const triggerId of triggerIds) {
			const channel = this.repo.triggers.get(triggerId)?.channel;
			if (channel && !ticket.channels.some((item) => sameChannel(item, channel))) ticket.channels.push(channel);
		}
		ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket;
		const assignment = this.newAssignment(ticket);
		this.repo.tickets.save(ticket);
		for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref);
		if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement);
		this.options.executor.start(this.require(id), assignment);
		this.emit("ticket.created", {
			ticketId: id,
			decisionId,
			strength: mandate.strength
		});
	}
	/**
	* Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	bind(ticketId, thread, own) {
		if (!liveTicket(this.require(ticketId))) throw new UserError("ticketEnded");
		this.subscribe(ticketId, thread);
		const ticket = this.require(ticketId);
		const followed = threadKey(thread);
		const follow = ticket.follows?.find((item) => item.thread === followed);
		if (follow) {
			follow.own ||= own;
			delete follow.closed;
		} else ticket.follows = [...ticket.follows ?? [], {
			thread: followed,
			own
		}];
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		return ticket;
	}
	/**
	* Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
	* work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
	*/
	threadClosed(thread, outcome, at) {
		const closed = threadKey(thread);
		for (const ticket of this.repo.tickets.open()) {
			const follow = ticket.follows?.find((item) => item.thread === closed && !item.closed);
			if (!follow) continue;
			follow.closed = {
				at,
				outcome
			};
			this.repo.tickets.save(ticket);
			const done = this.followsDone(ticket);
			if (!done || this.unfinished(ticket, at)) continue;
			const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? "") > Date.parse(at);
			this.end(ticket.id, "executor", done.outcome, resumed ? this.now() : done.at);
		}
	}
	/**
	* How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
	* once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
	*/
	followsDone(ticket) {
		const follows = ticket.follows ?? [];
		const own = follows.filter((item) => item.own);
		const counted = own.length ? own : follows;
		if (!counted.length || counted.some((item) => !item.closed)) return void 0;
		return counted.map((item) => item.closed).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
	}
	/**
	* The Trigger to attach to a ticket, once the ticket may take it.
	* @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
	*/
	attachable(ticketId, triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		this.leftToWorkers(trigger);
		const current = this.require(ticketId);
		if (current.ended?.by === "human") throw new UserError("ticketStopped");
		if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError("mandateRevoked");
		return trigger;
	}
	/**
	* Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
	* then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
	* message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
	*/
	attach(ticketId, trigger, note) {
		for (const ref of trigger.threads) this.subscribe(ticketId, ref);
		const current = this.repo.triggers.disposition(trigger.id) ?? {
			fanout: [],
			at: this.now()
		};
		const { context, requeued, ...disposition } = current;
		const followed = context?.filter((id) => id !== ticketId);
		this.repo.triggers.saveDisposition(trigger.id, {
			...disposition,
			fanout: [.../* @__PURE__ */ new Set([...disposition.fanout, ticketId])],
			...followed?.length ? { context: followed } : {}
		});
		const ticket = this.require(ticketId);
		const id = key("input", ticketId, "trigger", trigger.id);
		const existing = ticket.inputs.find((input) => input.id === id);
		const at = this.now();
		const input = (inputId) => ({
			id: inputId,
			kind: "trigger",
			triggerId: trigger.id,
			at,
			...note ? { note } : {},
			...trigger.human ? { human: true } : {}
		});
		if (existing?.kind !== "trigger") this.addInput(ticket, input(id));
		else if (note && ticket.undelivered.includes(id)) {
			existing.note = note;
			ticket.updatedAt = at;
			this.repo.tickets.save(ticket);
		} else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "attached", at)));
		else if (note) this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "note", note)));
	}
	/**
	* Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
	* @returns whether the status request input was queued.
	* @throws UserError when the ticket is unknown.
	*/
	requestStatus(ticketId) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== "waiting") return false;
		this.addInput(ticket, {
			id: `status:${ticketId}:${ticket.updatedAt}`,
			kind: "text",
			text: STATUS_REQUEST,
			at: this.now()
		});
		return true;
	}
	/**
	* Stops a ticket on behalf of a human, ending any active assignments.
	* @throws UserError when the ticket is unknown.
	*/
	stop(ticketId, reason) {
		this.end(ticketId, "human", "stopped", this.now(), reason);
		return this.require(ticketId);
	}
	/**
	* Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
	* @throws UserError when the ticket is unknown or not retryable.
	*/
	retry(ticketId) {
		const ticket = this.require(ticketId);
		const latest = latestAssignment(ticket);
		if (!canRetry(ticket) || !latest) throw new UserError("notRetryable");
		this.endAssignment(ticket, latest, "retried");
		this.requeueUntaken(ticket, latest);
		const assignment = this.newAssignment(ticket);
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		this.options.executor.stop(ticket, latest, "retried");
		this.options.executor.start(ticket, assignment);
		return ticket;
	}
	/**
	* Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
	* @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
	*/
	markUnrelated(ticketId, thread, reason) {
		const ticket = this.require(ticketId);
		if (this.source(ticket)?.threads.some((ref) => threadKey(ref) === thread)) throw new UserError("sourceThread");
		if (ticket.follows?.some((item) => item.thread === thread)) throw new UserError("followedThread");
		if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError("notFollowing");
		this.dropSubscriptions(thread, "executor", ticketId, reason);
		for (const trigger of this.triggersOf(ticket)) if (trigger.threads.some((ref) => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason);
	}
	/**
	* Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
	* were accepted; the others are left alone.
	*/
	policyChanged(from, to, effects) {
		const at = this.now();
		for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			const effect = effects.get(ticket.id);
			if (effect) this.addInput(ticket, {
				id: key("input", ticket.id, "policy", from, to, at),
				kind: "policy-changed",
				from,
				to,
				at,
				effect
			});
		}
	}
	/**
	* Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
	* followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
	* it received from the Thread.
	*/
	dropSubscriptions(thread, by, ticketId, reason) {
		const current = this.repo.threads.get(thread);
		const tickets = current?.subscriptions.filter((id) => ticketId === void 0 || id === ticketId) ?? [];
		if (!current || !tickets.length) return false;
		current.subscriptions = current.subscriptions.filter((id) => !tickets.includes(id));
		this.repo.threads.save(current);
		for (const id of tickets) {
			const ticket = this.repo.tickets.get(id);
			if (!ticket?.follows?.some((item) => item.thread === thread)) continue;
			const { follows: before, ...rest } = ticket;
			const follows = before.filter((item) => item.thread !== thread);
			this.repo.tickets.save(follows.length ? {
				...rest,
				follows
			} : rest);
		}
		for (const id of tickets) this.emit("thread.unsubscribed", {
			threadKey: current.key,
			ticketId: id,
			by,
			...reason ? { reason } : {}
		});
		return true;
	}
	/**
	* Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
	* failed once no person is waited for: a Policy change alone does not launch it again.
	*/
	addInput(ticket, input) {
		if (ticket.inputs.some((existing) => existing.id === input.id)) return;
		ticket.inputs.push(input);
		ticket.updatedAt = this.now();
		const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket);
		if (!held) ticket.undelivered.push(input.id);
		this.repo.tickets.save(ticket);
		if (!liveTicket(ticket) || held) return;
		const running = runningAssignment(ticket), latest = latestAssignment(ticket);
		if (running) this.options.executor.deliver(ticket, running);
		else if (latest?.state === "pending" && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest);
	}
	/**
	* Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
	* and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
	* takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
	* the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
	*/
	wake(ticketId) {
		const ticket = this.repo.tickets.get(ticketId);
		if (!ticket || liveTicket(ticket) || ticket.ended?.by === "human" || !ticket.undelivered.length) return;
		const policy = this.policy();
		if (policy.paused) return;
		if (!policy.revalidate(ticket.mandate)) {
			this.refuse(ticket);
			return;
		}
		const first = ticket.undelivered.map((id) => ticket.inputs.find((input) => input.id === id)).find((input) => input?.kind === "trigger" && input.human);
		if (first?.kind !== "trigger") return;
		const at = this.now();
		delete ticket.ended;
		ticket.updatedAt = at;
		const assignment = this.newAssignment(ticket);
		const resumed = {
			id: key("input", ticket.id, "resumed", first.triggerId),
			kind: "resumed",
			triggerId: first.triggerId,
			at
		};
		ticket.inputs.push(resumed);
		ticket.undelivered.unshift(resumed.id);
		this.repo.tickets.save(ticket);
		this.options.executor.start(ticket, assignment);
		this.emit("ticket.resumed", {
			ticketId,
			triggerId: first.triggerId
		});
	}
	/** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
	triggersOf(ticket, ids) {
		return ticket.inputs.flatMap((input) => input.kind === "trigger" && (!ids || ids.includes(input.id)) ? this.repo.triggers.get(input.triggerId) ?? [] : []);
	}
	/**
	* Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
	* acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
	*/
	takenUp(ticket, trigger) {
		const acked = this.repo.triggers.disposition(trigger.id)?.acked;
		return acked ? acked.includes(ticket.id) : this.options.outbox.status(key("ack", trigger.id)) !== void 0;
	}
	/** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
	untaken(ticket, ids) {
		return this.triggersOf(ticket, ids).filter((trigger) => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger));
	}
	/**
	* A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
	* messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
	* that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
	* up, a Decision settled it, or it is the message a stop ended this ticket on.
	*/
	letGo(ticketId, waiting, left) {
		for (const trigger of [...waiting, ...left]) {
			const disposition = this.repo.triggers.disposition(trigger.id);
			if (disposition?.fanout.includes(ticketId)) this.repo.triggers.saveDisposition(trigger.id, {
				...disposition,
				fanout: disposition.fanout.filter((id) => id !== ticketId)
			});
		}
		for (const trigger of left) {
			const disposition = this.repo.triggers.disposition(trigger.id);
			const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : void 0;
			const stopped = decision?.kind === "stop" && decision.ticketId === ticketId && !disposition?.handbacks?.length;
			const decided = !!decision && (settled(decision) || stopped);
			if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger);
		}
	}
	/** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
	refuse(ticket) {
		const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered);
		ticket.undelivered = [];
		this.repo.tickets.save(ticket);
		this.letGo(ticket.id, waiting, left);
	}
	/** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
	restart(ticket, running, reason, note) {
		this.endAssignment(ticket, running, reason);
		this.requeueUntaken(ticket, running);
		const assignment = this.newAssignment(ticket);
		const at = this.now();
		const input = {
			id: key("input", ticket.id, "restart", assignment.id),
			kind: "text",
			text: note,
			at
		};
		ticket.inputs.push(input);
		ticket.undelivered.push(input.id);
		ticket.updatedAt = at;
		this.repo.tickets.save(ticket);
		this.options.executor.start(ticket, assignment);
	}
	/**
	* Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
	* have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
	* in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
	*/
	requeueUntaken(ticket, replaced) {
		const untaken = ticket.inputs.filter((input) => input.kind === "trigger" && input.readAt === null && input.deliveredTo === replaced.id && !ticket.undelivered.includes(input.id));
		ticket.undelivered.unshift(...untaken.map((input) => input.id));
	}
	/**
	* End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
	* why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
	* the person's messages it decides that its worker did not read before its latest report or turn end, the report that
	* ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
	* the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
	*/
	end(ticketId, by, outcome, at = this.now(), reason) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) return;
		const stopping = ticket.assignments.filter((assignment) => assignment.state !== "ended");
		const why = reason && reason !== outcome ? { reason } : {};
		const until = readUntil(ticket);
		const waiting = this.triggersOf(ticket, ticket.undelivered);
		const left = this.untaken(ticket, ticket.inputs.flatMap((input) => input.kind === "trigger" && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []));
		ticket.ended = {
			at,
			by,
			outcome,
			...why
		};
		ticket.undelivered = [];
		ticket.updatedAt = this.now();
		delete ticket.attention;
		delete ticket.delivery;
		for (const assignment of stopping) {
			assignment.state = "ended";
			assignment.endedAt = at;
		}
		this.repo.tickets.save(ticket);
		this.letGo(ticketId, waiting, left);
		this.emit("ticket.ended", {
			ticketId,
			by,
			outcome,
			...why
		});
		for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome);
	}
	/**
	* Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
	* has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
	* after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
	* change asks for no work.
	*/
	unfinished(ticket, at) {
		const until = readUntil(ticket, false);
		const taken = this.triggersOf(ticket, ticket.inputs.flatMap((input) => input.kind === "trigger" && !readBefore(input, until) ? [input.id] : [])).some((trigger) => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger));
		const latest = latestAssignment(ticket);
		if (taken || !(Date.parse(latest?.createdAt ?? "") > Date.parse(at))) return taken;
		const report = latest?.report;
		const later = ticket.inputs.some((input) => input.kind !== "policy-changed" && Date.parse(input.at) > Date.parse(report?.at ?? ""));
		return report?.state !== "ready" || ticket.undelivered.length > 0 || later;
	}
	/** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
	newAssignment(ticket) {
		const assignment = {
			id: key("assignment", ticket.id, String(ticket.assignments.length)),
			state: "pending",
			createdAt: this.now()
		};
		ticket.assignments.push(assignment);
		delete ticket.delivery;
		return assignment;
	}
	endAssignment(ticket, assignment, reason) {
		assignment.state = "ended";
		assignment.endedAt = this.now();
		assignment.endedReason = reason;
		this.emit("assignment.ended", {
			ticketId: ticket.id,
			assignmentId: assignment.id,
			reason
		});
	}
	/**
	* Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	note(ticketId, text) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		const at = this.now();
		this.addInput(ticket, {
			id: key("input", ticketId, "note", at, text),
			kind: "note",
			text,
			at
		});
		return this.require(ticketId);
	}
	/**
	* Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
	* @returns false when the ticket follows the Thread already.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	followForContext(ticketId, ref) {
		if (!liveTicket(this.require(ticketId))) throw new UserError("ticketEnded");
		if (this.thread(ref).subscriptions.includes(ticketId)) return false;
		this.subscribe(ticketId, ref);
		const thread = this.thread(ref);
		thread.context = [...thread.context ?? [], ticketId];
		this.repo.threads.save(thread);
		return true;
	}
	/** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
	subscribe(ticketId, ref) {
		const thread = this.thread(ref);
		if (!thread.subscriptions.includes(ticketId)) {
			thread.subscriptions.push(ticketId);
			this.emit("thread.subscribed", {
				threadKey: thread.key,
				ticketId
			});
		}
		if (thread.context?.includes(ticketId)) thread.context = thread.context.filter((id) => id !== ticketId);
		this.repo.threads.save(thread);
	}
};
//#endregion
//#region src/core/assignments.ts
/** What the Executor and its workers report about the Assignments that run tickets. */
const RECOVERY_NOTE = "The host restarted during this ticket. Inspect the current working directory, durable history and prior outputs before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.";
/**
* Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
* reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
* interrupted it, and a worker's report with its question for a person. It depends on
* Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
* Executor's lifecycle callbacks and its workers' reports here.
*/
var Assignments = class extends EnginePart {
	tickets;
	replies;
	constructor(options, tickets, replies) {
		super(options);
		this.tickets = tickets;
		this.replies = replies;
	}
	/** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
	started(ticketId, assignmentId) {
		const ticket = this.require(ticketId);
		const assignment = ticket.assignments.find((item) => item.id === assignmentId);
		if (!assignment || assignment.state === "ended") return;
		assignment.state = "running";
		assignment.startedAt ??= this.now();
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment);
		this.emit("assignment.started", {
			ticketId,
			assignmentId
		});
	}
	/**
	* Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
	* longer running. Its worker reads each once its Session takes it into a step (see `read`).
	*/
	delivered(ticketId, assignmentId, inputIds) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		ticket.undelivered = ticket.undelivered.filter((id) => !inputIds.includes(id));
		ticket.updatedAt = this.now();
		runningAssignment(ticket).deliveredAt = ticket.updatedAt;
		for (const input of ticket.inputs) if (input.kind === "trigger" && inputIds.includes(input.id)) {
			input.readAt ??= null;
			input.deliveredTo = assignmentId;
		}
		delete ticket.delivery;
		this.repo.tickets.save(ticket);
	}
	/** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
	read(ticketId, inputIds) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) return;
		for (const input of ticket.inputs) if (input.kind === "trigger" && inputIds.includes(input.id)) input.readAt ||= this.now();
		this.repo.tickets.save(ticket);
	}
	turnEnded(ticketId, assignmentId) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		runningAssignment(ticket).idleAt = this.now();
		this.repo.tickets.save(ticket);
	}
	deliveryFailed(ticketId, assignmentId, error) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		ticket.delivery = {
			error: error.slice(0, 300),
			at: this.now()
		};
		this.repo.tickets.save(ticket);
	}
	/**
	* Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
	* `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
	* session and flushes any waiting undelivered inputs.
	*/
	interrupted(ticketId, assignmentId) {
		const ticket = this.running(ticketId, assignmentId);
		const running = ticket && runningAssignment(ticket);
		if (!ticket || !running) return;
		const report = running.report;
		const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at;
		if (!(!!report && [
			"waiting",
			"ready",
			"blocked",
			"failed"
		].includes(report.state) && !busy)) this.tickets.restart(ticket, running, "hostRestarted", RECOVERY_NOTE);
		else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running);
	}
	/**
	* Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
	* inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
	* @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
	* or a question/answer referencing a non-human or unreached trigger.
	*/
	report(ticketId, report) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		if (report.question && (report.state === "ready" || report.answers)) throw new UserError("questionWithResult");
		if (report.askedBy && !report.question) throw new UserError("askerWithoutQuestion");
		const person = (id, channel) => {
			const trigger = this.repo.triggers.get(id);
			return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false);
		};
		if (report.askedBy && !person(report.askedBy, true)) throw new UserError("notAsker");
		if (report.answers && !person(report.answers, false)) throw new UserError("notAnswerable");
		const assignment = runningAssignment(ticket) ?? latestAssignment(ticket);
		if (!assignment) throw new UserError("unknownAssignment");
		if (assignment.state === "ended") throw new UserError("assignmentEnded");
		const at = this.now();
		const previous = ticket.attention;
		const ask = (question) => ({
			id: key("attention", ticketId, question, at),
			question,
			...report.askedBy ? { triggerId: report.askedBy } : {}
		});
		const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous;
		const attention = report.question === null || report.state === "ready" ? void 0 : asked;
		if (attention) ticket.attention = attention;
		else delete ticket.attention;
		if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id);
		assignment.report = {
			state: report.state,
			summary: report.summary,
			at
		};
		ticket.updatedAt = at;
		if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers];
		if (report.answers) this.takeUp(ticketId, report.answers);
		if (report.state === "blocked" || report.state === "failed") ticket.undelivered = ticket.undelivered.filter((id) => !automatic(ticket.inputs.find((input) => input.id === id)));
		this.repo.tickets.save(ticket);
		const ready = !ticket.follows?.length ? "completed" : this.tickets.followsDone(ticket)?.outcome;
		const outcome = report.state === "dropped" ? this.tickets.followsDone(ticket)?.outcome ?? "dropped" : report.state === "ready" ? ready : void 0;
		if (outcome) this.tickets.end(ticketId, "executor", outcome, at);
		return this.require(ticketId);
	}
	/** The ticket, while it is open and `assignmentId` runs it. */
	running(ticketId, assignmentId) {
		const ticket = this.require(ticketId);
		return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : void 0;
	}
};
//#endregion
//#region src/core/reasons.ts
/**
* Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
* Policy gates and source scopes may also emit their own literal reason codes.
*/
const REASONS = {
	said: "{text}",
	timeout: "Assessment timed out",
	policyChanged: "Policy changed during assessment",
	noAdmissible: "No admissible trigger",
	startedTicket: "Already started ticket {ticket}",
	acceptedBefore: "Trigger {trigger} was accepted before",
	routed: "Routed to ticket {ticket}",
	explicitRouted: "Explicit request from an allowed sender routed by the orchestrator",
	humanStop: "Human asked to stop",
	legacyImport: "Imported from the pre-domain-model task record",
	forwarded: "Forwarded to the worker of the Ticket already on this Thread",
	senderNotMember: "The sender is not on the Source's list",
	retried: "Retried by a person",
	hostRestarted: "dsh-superagent restarted",
	stopUnknown: "Stop target is unknown or already ended",
	stopNotExplicit: "A stop needs an explicit request from a sender on the list",
	directionUnsettled: "Implementation intent or target direction is not established, or a product/design decision is still required",
	noRuleMatched: "No enabled admission rule matched",
	ignoredFromCard: "Ignored from its card, without a rule assessment",
	observed: "Observe mode: would accept ({text})"
};
const said = (text) => ({
	code: "said",
	values: { text }
});
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
function reasonText(reasons) {
	return [reasons ?? []].flat().map((reason) => {
		const text = (REASONS[reason.code] ?? reason.code).replace(/\{(\w+)\}/g, (match, name) => reason.values?.[name] ?? match);
		return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
	}).join("; ");
}
//#endregion
//#region src/core/evals.ts
/** Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with. */
/** An outcome's reason: a code it carries, else the words its assessor or person wrote. */
const reasonOf = (reason) => [typeof reason === "string" ? said(reason) : reason];
const stronger = (a, b) => a === "explicit" || b === "explicit" ? "explicit" : "inferred";
/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2;
/**
* Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
* from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, stop,
* ignore, or unavailable. It depends on Tickets to create the ticket an accept decides and to end the one a stop names; the
* Engine routes the main Session's decisions, people's replays, worker handbacks, and the pass's Eval work here.
*/
var Evals = class extends EnginePart {
	tickets;
	constructor(options, tickets) {
		super(options);
		this.tickets = tickets;
	}
	/**
	* Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
	* processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
	* candidate has not reached the assessor's Session does not expire.
	*/
	due(thread, policy) {
		const evaluation = thread.evaluating;
		if (!evaluation || policy.paused && evaluation.pausedAt) return;
		const now = this.now();
		if (policy.paused) evaluation.pausedAt = now;
		else if (evaluation.pausedAt) {
			evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString();
			delete evaluation.pausedAt;
		} else if (evaluation.delivered && evaluation.deadline <= now) {
			this.expire(thread);
			return;
		} else return;
		this.repo.threads.save(thread);
	}
	/** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
	delivered(evalId, policy) {
		const thread = this.repo.threads.active().find((item) => item.evaluating?.id === evalId);
		if (!thread?.evaluating || thread.evaluating.delivered) return;
		const now = this.now();
		thread.evaluating.delivered = now;
		thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString();
		this.repo.threads.save(thread);
	}
	/**
	* An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
	* assessor does not drop requests; after that it is recorded unavailable.
	*/
	expire(thread) {
		const expired = (thread.expired ?? 0) + 1;
		if (expired > REQUEUES) {
			this.finish(thread, thread.evaluating, {
				kind: "unavailable",
				reason: [{ code: "timeout" }]
			});
			return;
		}
		const { id, triggerIds } = thread.evaluating;
		delete thread.evaluating;
		thread.expired = expired;
		thread.pending = [...triggerIds, ...thread.pending.filter((item) => !triggerIds.includes(item))];
		this.repo.threads.save(thread);
		this.options.assessor.release?.(id);
	}
	/** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
	start(threadKeyValue, policy) {
		const thread = this.repo.threads.get(threadKeyValue);
		const at = this.now();
		const delivered = (id) => {
			const trigger = this.repo.triggers.get(id);
			return !!trigger && this.owners(trigger).length > 0;
		};
		if (thread.pending.some(delivered)) {
			const followups = thread.pending.filter(delivered);
			thread.pending = thread.pending.filter((id) => !followups.includes(id));
			this.repo.threads.save(thread);
			for (const triggerId of followups) this.emit("trigger.followup", { triggerId });
			if (!thread.pending.length) return;
		}
		const accepted = this.accepted(thread.key);
		const started = thread.pending.filter((id) => accepted.has(id));
		const startedTicket = (id) => ({
			code: "startedTicket",
			triggerId: id,
			values: { ticket: accepted.get(id).ticketId }
		});
		if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at);
		const triggers = thread.pending.flatMap((id) => {
			const trigger = this.repo.triggers.get(id);
			return trigger ? [trigger] : [];
		});
		const tickets = this.ticketsOnThread(thread);
		const reasons = [];
		let strongest;
		for (const trigger of triggers) {
			const gate = policy.gate(trigger, thread, tickets);
			if (!gate.admissible) {
				reasons.push({
					code: gate.reason,
					triggerId: trigger.id
				});
				continue;
			}
			const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at;
			if (!strongest || stronger(strongest.strength, gate.strength) !== strongest.strength || later) strongest = {
				trigger,
				strength: gate.strength,
				basis: gate.basis
			};
		}
		if (!strongest) {
			if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: "noAdmissible" }], policy, at);
			this.repo.threads.save(thread);
			return;
		}
		const evalId = key("eval", thread.key, policy.version, at, ...thread.pending);
		const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString();
		const { strength, trigger: { actor }, basis } = strongest;
		thread.evaluating = {
			id: evalId,
			threadKey: thread.key,
			triggerIds: thread.pending,
			primary: strongest.trigger.id,
			strength,
			actor,
			basis,
			policyVersion: policy.version,
			startedAt: at,
			deadline
		};
		thread.pending = [];
		this.repo.threads.save(thread);
		for (const trigger of triggers) this.repo.triggers.saveDisposition(trigger.id, {
			...this.repo.triggers.disposition(trigger.id) ?? {
				fanout: [],
				at
			},
			evalId
		});
		this.emit("eval.started", {
			evalId,
			threadKey: thread.key,
			triggerIds: thread.evaluating.triggerIds,
			strength: strongest.strength
		});
		this.options.assessor.request(this.candidateOf(thread));
	}
	/** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
	candidate(triggerId) {
		const thread = this.holding(triggerId);
		return thread && this.candidateOf(thread);
	}
	/**
	* Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
	* @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
	* ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
	* mode or without enabled matching rules.
	*/
	decide(triggerId, outcome) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		const held = this.holding(triggerId);
		if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError("evalFinished", { eval: outcome.evalId });
		const earlier = outcome.kind === "accept" ? this.accepted(threadKey(trigger.threads[0])).get(triggerId) : void 0;
		if (earlier) {
			const others = held?.evaluating?.triggerIds.filter((id) => id !== triggerId) ?? [];
			if (held && others.length) this.reassess(held, {
				code: "acceptedBefore",
				values: { trigger: triggerId }
			}, [triggerId]);
			else if (held) this.finish(held, held.evaluating, {
				kind: "ignore",
				reason: [{
					code: "startedTicket",
					triggerId,
					values: { ticket: earlier.ticketId }
				}]
			});
			return earlier;
		}
		if (outcome.kind !== "stop") this.leftToWorkers(trigger);
		const thread = held ?? this.thread(trigger.threads[0]);
		const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === "stop" ? outcome.ticketId : void 0);
		if (outcome.kind === "accept" && evaluation.strength !== "explicit" && !this.policy().admitsInferred(outcome.rules ?? [])) throw new UserError("notExplicit");
		return this.decideEval(thread, evaluation, outcome);
	}
	/**
	* Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
	* @throws UserError when the Trigger is unknown.
	*/
	reevaluate(triggerId) {
		if (!this.requeue(triggerId)) return false;
		this.emit("trigger.requeued", { triggerId });
		return true;
	}
	/** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
	requeue(triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		if (this.holding(triggerId)) return false;
		this.queueForEval(trigger);
		const disposition = this.repo.triggers.disposition(triggerId) ?? {
			fanout: [],
			at: this.now()
		};
		this.repo.triggers.saveDisposition(triggerId, {
			...disposition,
			requeued: true
		});
		return true;
	}
	/**
	* Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
	* when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
	* Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
	* and hands a Trigger back once.
	* @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
	*/
	handback(ticketId, triggerId, reason) {
		if (!this.require(ticketId).inputs.some((input) => input.kind === "trigger" && input.triggerId === triggerId)) throw new UserError("notReached");
		if (this.repo.triggers.disposition(triggerId)?.handbacks?.some((item) => item.ticketId === ticketId)) throw new UserError("handedBack");
		return this.handBack(ticketId, this.repo.triggers.get(triggerId), reason);
	}
	/**
	* Marks an `unavailable` Decision dismissed so the overview lists it no more.
	* @throws UserError when the Decision is unknown or not `unavailable`.
	*/
	dismiss(decisionId) {
		const decision = this.repo.decisions.get(decisionId);
		if (decision?.kind !== "unavailable") throw new UserError("unknownProblem");
		decision.dismissed = true;
		this.repo.decisions.save(decision);
		return decision;
	}
	/** Take a Trigger out of its Thread's queue because it was routed by hand. */
	withdraw(trigger) {
		const thread = this.repo.threads.get(threadKey(trigger.threads[0]));
		if (!thread?.pending.includes(trigger.id)) return;
		thread.pending = thread.pending.filter((id) => id !== trigger.id);
		this.repo.threads.save(thread);
	}
	/**
	* End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
	* queues them again for a fresh Eval without it.
	*/
	routed(triggerId, ticketId) {
		const held = this.holding(triggerId);
		const reason = {
			code: "routed",
			values: { ticket: ticketId }
		};
		if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, {
			kind: "ignore",
			reason: [reason]
		});
		else if (held) this.reassess(held, {
			...reason,
			triggerId
		}, [triggerId]);
	}
	/** Start the Evals in progress again under the new Policy version, and say that it changed. */
	policyChanged(from, to) {
		for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: "policyChanged" });
		this.emit("policy.changed", {
			from,
			to
		});
	}
	/** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
	reassess(thread, reason, without = []) {
		const ids = thread.evaluating.triggerIds.filter((id) => !without.includes(id));
		const decision = this.finish(thread, thread.evaluating, {
			kind: "unavailable",
			reason: [reason]
		});
		const current = this.repo.threads.get(thread.key);
		current.pending = [...ids, ...current.pending.filter((id) => !ids.includes(id))];
		this.repo.threads.save(current);
		return decision;
	}
	/** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
	holding(triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]));
		return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : void 0;
	}
	candidateOf(thread) {
		const evaluation = thread.evaluating;
		const triggers = evaluation.triggerIds.flatMap((id) => {
			const trigger = this.repo.triggers.get(id);
			return trigger ? [trigger] : [];
		});
		const { id: evalId, strength, policyVersion } = evaluation;
		return {
			evalId,
			thread,
			triggers,
			strength,
			policyVersion,
			tickets: this.ticketsOnThread(thread)
		};
	}
	/**
	* Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
	* differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
	*/
	ignore(thread, ids, reason, policy, at) {
		const evaluation = {
			id: key("eval", thread.key, "ignored", policy.version, at, ...ids),
			threadKey: thread.key,
			triggerIds: ids,
			strength: "inferred",
			actor: {
				source: thread.ref.source,
				id: ""
			},
			basis: { via: "followup" },
			policyVersion: policy.version,
			startedAt: at,
			deadline: at
		};
		this.record(thread, evaluation, {
			kind: "ignore",
			reason
		});
		thread.pending = thread.pending.filter((id) => !ids.includes(id));
		delete thread.expired;
	}
	/**
	* The accept Decisions of the Triggers whose primary Thread is `threadKey`, by Trigger: what each one started. An Eval and
	* its Decision run on its Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
	*/
	accepted(threadKey) {
		const accepted = /* @__PURE__ */ new Map();
		for (const decision of this.repo.decisions.byThread(threadKey)) {
			if (decision.kind !== "accept" || !decision.ticketId) continue;
			for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision);
		}
		return accepted;
	}
	/**
	* A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
	* ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
	* Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
	*/
	directEval(thread, trigger, kind, ticketId) {
		const policy = this.policy();
		const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread));
		if (!gate.admissible) throw new UserError("notAdmissible", { reason: gate.reason });
		const at = this.now();
		if (thread.pending.includes(trigger.id)) {
			thread.pending = thread.pending.filter((id) => id !== trigger.id);
			this.repo.threads.save(thread);
		}
		return {
			id: key("eval", thread.key, "direct", trigger.id, kind, ...ticketId ? [ticketId] : [], at),
			threadKey: thread.key,
			triggerIds: [trigger.id],
			primary: trigger.id,
			strength: gate.strength,
			actor: trigger.actor,
			basis: gate.basis,
			policyVersion: policy.version,
			startedAt: at,
			deadline: at
		};
	}
	/** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
	decideEval(thread, evaluation, outcome) {
		const audit = outcome.audit ? { audit: outcome.audit } : {};
		if (this.policy().version !== evaluation.policyVersion) {
			if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: "policyChanged" });
			return this.finish(thread, evaluation, {
				kind: "unavailable",
				reason: [{ code: "policyChanged" }],
				...audit
			});
		}
		const unassessed = outcome.kind === "ignore" && evaluation.strength !== "explicit" && !outcome.audit ? [{ code: "ignoredFromCard" }] : [];
		if (outcome.kind === "ignore" || outcome.kind === "unavailable") return this.finish(thread, evaluation, {
			kind: outcome.kind,
			reason: [...unassessed, ...reasonOf(outcome.reason)],
			...audit
		});
		if (outcome.kind === "stop") {
			const ticket = this.repo.tickets.get(outcome.ticketId);
			if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, {
				kind: "ignore",
				reason: [{ code: "stopUnknown" }],
				...audit
			});
			if (evaluation.strength !== "explicit") return this.finish(thread, evaluation, {
				kind: "ignore",
				reason: [{ code: "stopNotExplicit" }],
				...audit
			});
			const decision = this.finish(thread, evaluation, {
				kind: "stop",
				reason: reasonOf(outcome.reason),
				ticketId: ticket.id,
				...audit
			});
			this.tickets.end(ticket.id, "human", "stopped", this.now(), typeof outcome.reason === "string" ? outcome.reason : void 0);
			return decision;
		}
		return this.accept(thread, evaluation, outcome);
	}
	/** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
	accept(thread, evaluation, outcome) {
		const at = this.now();
		const basis = {
			...evaluation.basis,
			...outcome.rules ? { rules: outcome.rules } : {}
		};
		const { strength, policyVersion, actor } = evaluation;
		const mandate = {
			strength,
			policyVersion,
			basis,
			actor,
			scope: outcome.scope
		};
		const ticketId = key("ticket", evaluation.id);
		const audit = outcome.audit ? { audit: outcome.audit } : {};
		const decision = this.finish(thread, evaluation, {
			kind: "accept",
			reason: reasonOf(outcome.reason),
			...audit,
			mandate,
			ticketId
		});
		this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at);
		return decision;
	}
	/** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
	finish(thread, evaluation, outcome) {
		const decision = this.record(thread, evaluation, outcome);
		if (thread.evaluating?.id !== evaluation.id) return decision;
		delete thread.evaluating;
		delete thread.expired;
		this.repo.threads.save(thread);
		this.options.assessor.release?.(evaluation.id);
		return decision;
	}
	record(thread, evaluation, outcome) {
		const at = this.now();
		const decision = {
			id: key("decision", evaluation.id),
			evalId: evaluation.id,
			threadKey: thread.key,
			triggerIds: evaluation.triggerIds,
			policyVersion: evaluation.policyVersion,
			at,
			kind: outcome.kind,
			reason: outcome.reason,
			strength: evaluation.strength,
			...outcome.ticketId ? { ticketId: outcome.ticketId } : {},
			...outcome.mandate ? { mandate: outcome.mandate } : {},
			...outcome.audit ? { audit: outcome.audit } : {}
		};
		this.repo.decisions.save(decision);
		for (const id of evaluation.triggerIds) {
			const disposition = this.repo.triggers.disposition(id) ?? {
				fanout: [],
				at
			};
			this.repo.triggers.saveDisposition(id, {
				...disposition,
				evalId: evaluation.id,
				decisionId: decision.id
			});
		}
		this.emit("decision.recorded", {
			decisionId: decision.id,
			kind: decision.kind,
			threadKey: thread.key
		});
		return decision;
	}
};
//#endregion
//#region src/core/intake.ts
/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
/**
* Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
* Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
* ticket's worker decides (see `followupOwners`).
* Engine delegates trigger reception to this part.
*/
var Intake = class extends EnginePart {
	tickets;
	constructor(options, tickets) {
		super(options);
		this.tickets = tickets;
	}
	receive(received) {
		const trigger = {
			...received,
			at: isoTime(received.at)
		};
		if (!trigger.threads.length) throw new Error("A trigger must belong to at least one thread");
		if (this.repo.triggers.get(trigger.id)) return "duplicate";
		const at = this.now();
		const filter = this.options.scope.scope(trigger);
		if (!filter.listened) {
			this.repo.triggers.save(trigger);
			this.repo.triggers.saveDisposition(trigger.id, {
				filtered: { code: filter.reason },
				fanout: [],
				at
			});
			return "filtered";
		}
		this.repo.triggers.save(trigger);
		const keys = trigger.threads.map(threadKey);
		const reached = /* @__PURE__ */ new Map();
		for (const ref of trigger.threads) {
			const thread = this.thread(ref);
			if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at;
			thread.correlated = [.../* @__PURE__ */ new Set([...thread.correlated, ...keys.filter((other) => other !== thread.key)])];
			for (const ticketId of thread.subscriptions) {
				const ticket = this.repo.tickets.get(ticketId);
				const followed = !!thread.context?.includes(ticketId);
				const resumes = trigger.human && ticket?.ended?.by !== "human" && !followed;
				if (!ticket || !liveTicket(ticket) && !resumes) continue;
				reached.set(ticketId, {
					ticket,
					context: followed && (reached.get(ticketId)?.context ?? true)
				});
			}
			this.repo.threads.save(thread);
		}
		for (const [ticketId, { ticket, context: followed }] of reached) this.tickets.addInput(ticket, {
			id: key("input", ticketId, "trigger", trigger.id),
			kind: "trigger",
			triggerId: trigger.id,
			at,
			...trigger.human ? { human: true } : {},
			...followed ? { context: true } : {}
		});
		const fanout = [...reached.keys()], context = fanout.filter((id) => reached.get(id).context);
		const disposition = {
			fanout,
			...context.length ? { context } : {},
			at
		};
		this.repo.triggers.saveDisposition(trigger.id, disposition);
		if (!this.owners(trigger).length) this.queueForEval(trigger);
		for (const ticketId of fanout) this.tickets.wake(ticketId);
		this.emit("trigger.received", {
			triggerId: trigger.id,
			threads: trigger.threads.map(threadKey)
		});
		return "stored";
	}
};
//#endregion
//#region src/core/replies.ts
/** The Engine's messages to Channels, each by the rule that allows it. */
/**
* Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
* question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
* that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
* an accept carries, and Assignments asks it to withdraw a question a report replaced.
*/
var Replies = class extends EnginePart {
	/**
	* Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
	* written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
	* result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
	* `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
	* records that the ticket's worker took the message up.
	* @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
	* that is not ready, completed, merged, or dropped.
	*/
	reply(request) {
		return request.purpose === "acknowledgement" ? this.acknowledge(request) : this.answer(request);
	}
	/**
	* Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
	* and a person wrote it.
	*/
	acknowledgeAccepted(ticketId, trigger, text) {
		if (trigger.channel && trigger.human) this.options.outbox.send({
			id: key("ack", trigger.id),
			channel: trigger.channel,
			text,
			kind: "acknowledgement",
			ticketId
		});
	}
	/** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
	withdrawAttention(attentionId) {
		this.options.outbox.withdraw(key("attention-reply", attentionId));
	}
	acknowledge(request) {
		const ticket = this.require(request.ticketId);
		if (!liveTicket(ticket)) throw new UserError("ackEnded");
		const trigger = this.repo.triggers.get(request.triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		if (!this.reaches(ticket, trigger, false)) throw new UserError("notReached");
		if (!trigger.channel) throw new UserError("ackNoChannel");
		const id = key("ack", trigger.id);
		const existing = this.options.outbox.status(id);
		if (!existing && !trigger.human) throw new UserError("ackNotPerson");
		if (!existing) this.options.outbox.send({
			id,
			channel: trigger.channel,
			text: request.text,
			kind: "acknowledgement",
			ticketId: ticket.id
		});
		this.takeUp(ticket.id, trigger.id);
		return {
			id,
			status: this.options.outbox.status(id) ?? "pending",
			reused: existing !== void 0
		};
	}
	answer(request) {
		const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : void 0;
		if (request.triggerId && !trigger) throw new UserError("unknownTrigger");
		const ticket = request.ticketId ? this.require(request.ticketId) : trigger ? this.repo.tickets.list().find((item) => this.reaches(item, trigger)) : void 0;
		if (request.purpose === "result") {
			const outcome = ticket && ticketOutcome(ticket);
			const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === "ready";
			if (!ticket || !(outcome === "merged" || outcome === "completed" || outcome === "dropped" || reported)) throw new UserError("notReady");
		}
		const attention = request.purpose === "attention" ? ticket?.attention : void 0;
		if (request.purpose === "attention" && (!attention || attention.question !== request.question)) throw new UserError("notAttention");
		if (request.purpose === "answer" && !trigger?.human) throw new UserError("notQuestion");
		const id = attention ? key("attention-reply", attention.id) : key("reply", trigger?.id ?? ticket?.id ?? "", request.text);
		const existing = this.options.outbox.status(id);
		const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id);
		if (request.purpose === "answer" && !ready && !existing) throw new UserError("noAnswer");
		const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : void 0;
		const channel = request.purpose === "answer" ? trigger.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : void 0);
		if (!channel) throw new UserError("noChannel");
		this.options.outbox.send({
			id,
			channel,
			text: request.text,
			kind: "reply",
			...ticket ? { ticketId: ticket.id } : {}
		});
		if (request.purpose === "answer" && ticket && trigger && ticket.answers?.includes(trigger.id)) {
			ticket.answers = ticket.answers.filter((item) => item !== trigger.id);
			this.repo.tickets.save(ticket);
		}
		return {
			id,
			status: this.options.outbox.status(id) ?? "pending",
			reused: existing !== void 0
		};
	}
	/** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
	sourceChannel(ticket) {
		return this.source(ticket)?.channel ?? ticket.channels[0];
	}
};
//#endregion
//#region src/core/engine.ts
/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
/**
* Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
* Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
* effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
*/
var Engine = class {
	options;
	repo;
	replies;
	tickets;
	assignments;
	evals;
	intake;
	constructor(options) {
		this.options = options;
		this.repo = options.repo;
		this.replies = new Replies(options);
		this.tickets = new Tickets(options, this.replies);
		this.assignments = new Assignments(options, this.tickets, this.replies);
		this.evals = new Evals(options, this.tickets);
		this.intake = new Intake(options, this.tickets);
	}
	/**
	* A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
	* ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
	* and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
	* Triggers that arrive while an Eval of that Thread runs wait together for the next one.
	*/
	receive(trigger) {
		return this.repo.atomic(() => this.intake.receive(trigger));
	}
	/**
	* A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
	* opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	bindThread(ticketId, thread, own) {
		return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own));
	}
	/**
	* A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
	* follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
	* its worker took up a person's message the ticket decides after its latest report.
	*/
	threadClosed(thread, outcome, at) {
		this.repo.atomic(() => {
			this.tickets.threadClosed(thread, outcome, isoTime(at));
		});
	}
	/**
	* Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
	* Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
	* paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
	* moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
	*/
	evaluateDue() {
		const policy = this.options.policy();
		for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => {
			this.evals.due(thread, policy);
		});
		if (policy.paused) return;
		for (const ticket of this.repo.tickets.active()) if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => {
			this.tickets.wake(ticket.id);
		});
		for (const thread of this.repo.threads.active()) if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => {
			this.evals.start(thread.key, policy);
		});
	}
	/** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
	candidate(triggerId) {
		return this.evals.candidate(triggerId);
	}
	/**
	* Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
	* request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
	* matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
	* `ignore`; one judged under an older Policy as `unavailable`.
	* @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
	* ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
	* mode or without enabled matching rules.
	*/
	decide(triggerId, outcome) {
		return this.repo.atomic(() => this.evals.decide(triggerId, outcome));
	}
	/**
	* Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
	* Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
	* its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
	* message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
	* once unless processing is paused.
	* @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
	*/
	attach(ticketId, triggerId, note) {
		return this.repo.atomic(() => {
			if (this.repo.triggers.disposition(triggerId)?.handbacks?.some((item) => item.ticketId === ticketId)) throw new UserError("handedBackHere");
			const trigger = this.tickets.attachable(ticketId, triggerId);
			this.evals.withdraw(trigger);
			this.tickets.attach(ticketId, trigger, note);
			this.evals.routed(triggerId, ticketId);
			this.tickets.wake(ticketId);
			return this.repo.tickets.get(ticketId);
		});
	}
	/**
	* Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
	* @returns whether the worker was asked.
	* @throws UserError when the ticket is unknown.
	*/
	requestStatus(ticketId) {
		return this.repo.atomic(() => this.tickets.requestStatus(ticketId));
	}
	/**
	* Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
	* written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
	* started in. A message queued before is not queued again (see `Replies.reply`).
	* @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
	* is not ready, completed, merged, or dropped.
	*/
	reply(request) {
		return this.repo.atomic(() => this.replies.reply(request));
	}
	/** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
	candidateDelivered(evalId) {
		this.repo.atomic(() => {
			this.evals.delivered(evalId, this.options.policy());
		});
	}
	/**
	* Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
	* @throws UserError when the trigger is unknown.
	*/
	reevaluate(triggerId) {
		return this.repo.atomic(() => this.evals.reevaluate(triggerId));
	}
	/**
	* A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
	* @throws UserError for a Decision that is unknown or not unavailable.
	*/
	dismiss(decisionId) {
		return this.repo.atomic(() => this.evals.dismiss(decisionId));
	}
	/**
	* Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
	* @returns whether a Subscription was dropped.
	*/
	unsubscribe(thread) {
		return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, "person"));
	}
	/**
	* A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
	* @throws UserError when the ticket is unknown.
	*/
	stopTicket(ticketId, reason) {
		return this.repo.atomic(() => this.tickets.stop(ticketId, reason));
	}
	/**
	* A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
	* Assignment ends and a new one starts under the same Mandate.
	* @throws UserError when the ticket is unknown, has ended, or is not retryable.
	*/
	retryTicket(ticketId) {
		return this.repo.atomic(() => this.tickets.retry(ticketId));
	}
	/**
	* The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
	* @throws UserError when the ticket is unknown.
	*/
	assignmentStarted(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.started(ticketId, assignmentId);
		});
	}
	/**
	* The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
	* an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
	*/
	inputsDelivered(ticketId, assignmentId, inputIds) {
		this.repo.atomic(() => {
			this.assignments.delivered(ticketId, assignmentId, inputIds);
		});
	}
	/**
	* The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
	* which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
	* @throws UserError when the ticket is unknown.
	*/
	inputsRead(ticketId, inputIds) {
		this.repo.atomic(() => {
			this.assignments.read(ticketId, inputIds);
		});
	}
	/** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
	turnEnded(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.turnEnded(ticketId, assignmentId);
		});
	}
	/** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
	deliveryFailed(ticketId, assignmentId, error) {
		this.repo.atomic(() => {
			this.assignments.deliveryFailed(ticketId, assignmentId, error);
		});
	}
	/**
	* A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
	* ticket's Subscription drops, until a new Decision subscribes it again.
	* @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
	* its pull request's), or one it does not follow.
	*/
	markUnrelated(ticketId, thread, reason) {
		this.repo.atomic(() => {
			this.tickets.markUnrelated(ticketId, thread, reason);
		});
	}
	/**
	* An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
	* @returns false when the ticket already follows the Thread.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	followForContext(ticketId, thread) {
		return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread));
	}
	/**
	* A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	note(ticketId, text) {
		return this.repo.atomic(() => this.tickets.note(ticketId, text));
	}
	/**
	* An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
	* @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
	* @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
	*/
	handback(ticketId, triggerId, reason) {
		return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason));
	}
	/**
	* Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
	* cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
	* from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
	* report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
	* outcome once `followsDone` holds.
	* @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
	* answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
	*/
	report(ticketId, report) {
		return this.repo.atomic(() => this.assignments.report(ticketId, report));
	}
	/**
	* Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
	* `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
	* Session and state and gets the Inputs that wait for it.
	*/
	assignmentInterrupted(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.interrupted(ticketId, assignmentId);
		});
	}
	/**
	* The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
	* under the new version.
	*/
	policyChanged(from, to, effects = /* @__PURE__ */ new Map()) {
		this.repo.atomic(() => {
			this.tickets.policyChanged(from, to, effects);
			this.evals.policyChanged(from, to);
		});
	}
};
//#endregion
//#region src/core/memory.ts
/** In-memory repository implementation for testing and ephemeral engine instances. */
const clone = (value) => structuredClone(value);
/**
* In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
* Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
*/
var MemoryRepositories = class {
	triggerRows = /* @__PURE__ */ new Map();
	dispositions = /* @__PURE__ */ new Map();
	threadRows = /* @__PURE__ */ new Map();
	ticketRows = /* @__PURE__ */ new Map();
	decisionRows = /* @__PURE__ */ new Map();
	atomic(work) {
		const maps = [
			this.triggerRows,
			this.dispositions,
			this.threadRows,
			this.ticketRows,
			this.decisionRows
		];
		const snapshot = maps.map((map) => new Map(map));
		try {
			return work();
		} catch (error) {
			maps.forEach((map, index) => {
				map.clear();
				for (const [id, value] of snapshot[index]) map.set(id, value);
			});
			throw error;
		}
	}
	triggers = {
		get: (id) => clone(this.triggerRows.get(id)),
		save: (trigger) => {
			this.triggerRows.set(trigger.id, clone(trigger));
		},
		disposition: (id) => clone(this.dispositions.get(id)),
		saveDisposition: (id, value) => {
			this.dispositions.set(id, clone(value));
		}
	};
	threads = {
		get: (key) => clone(this.threadRows.get(key)),
		save: (thread) => {
			this.threadRows.set(thread.key, clone(thread));
		},
		list: () => [...this.threadRows.values()].map(clone),
		active: () => this.threads.list().filter((thread) => thread.pending.length > 0 || thread.evaluating !== void 0)
	};
	tickets = {
		get: (id) => clone(this.ticketRows.get(id)),
		save: (ticket) => {
			this.ticketRows.set(ticket.id, clone(ticket));
		},
		/** Newest first, matching the SQLite Store's order. */
		list: () => [...this.ticketRows.values()].reverse().map(clone),
		open: () => this.tickets.list().filter((ticket) => !ticket.ended),
		active: () => this.tickets.list().filter((ticket) => ticket.undelivered.length > 0 || ["pending", "running"].includes(latestAssignment(ticket)?.state ?? ""))
	};
	decisions = {
		get: (id) => clone(this.decisionRows.get(id)),
		save: (decision) => {
			this.decisionRows.set(decision.id, clone(decision));
		},
		byThread: (key) => [...this.decisionRows.values()].filter((decision) => decision.threadKey === key).map(clone)
	};
};
//#endregion
//#region src/infra/health.ts
/**
* Central registry of component health entries, enforcing single-writer ownership per entry name.
* Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
*/
var HealthBoard = class {
	entries = {};
	claimed = /* @__PURE__ */ new Set();
	claim(name, initial) {
		if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`);
		this.claimed.add(name);
		if (initial) this.entries[name] = initial;
		let held = true;
		return {
			get: () => this.entries[name],
			set: (health) => {
				if (held) this.entries[name] = health;
			},
			release: () => {
				if (!held) return;
				held = false;
				this.claimed.delete(name);
				delete this.entries[name];
			}
		};
	}
	get all() {
		return this.entries;
	}
};
//#endregion
//#region src/company-environment.ts
const executionRoot = (settings, stateDir) => settings.executor.directory || `${stateDir}/work`;
var CommandError = class extends Error {
	exitCode;
	constructor(message, exitCode) {
		super(message);
		this.exitCode = exitCode;
	}
};
/** 通过 DSH subprocess 运行准备命令，不读取或转发任何凭据。 */
async function runAsWorker(subprocess, argv, cwd, signal, env) {
	const handle = subprocess.spawn({
		argv,
		cwd,
		graceMs: 2e3,
		signal,
		...env ? { env } : {},
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 1 << 20 },
			stderr: { maxBytes: 65536 }
		}
	});
	const { exitCode } = await handle.done;
	const read = (reader) => reader?.readFrom(0).text ?? "";
	if (exitCode === 0) return read(handle.collected.stdout);
	const ended = exitCode === null ? "was stopped before it finished" : `exited with ${exitCode}`;
	throw new CommandError(read(handle.collected.stderr).trim() || `${argv.join(" ")} ${ended}`, exitCode ?? void 0);
}
/** 拒绝仓库本地配置中的凭据助手和 HTTP extraheader，非 Git 目录按普通工作目录处理。 */
async function verifyDirectory(directory, subprocess, signal) {
	const scoped = (await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-scope",
		"--get-regexp",
		"^(credential\\..*|http\\..*extraheader)$"
	], directory, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch((error) => {
		if (error instanceof CommandError && error.exitCode === 1) return "";
		throw error;
	})).split("\0");
	const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === "local" || scope === "worktree") ? [scoped[index + 1].split("\n")[0]] : []);
	if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(", ")}, which the agent's git would also read; remove them.`);
}
//#endregion
//#region src/app/effects.ts
/**
* Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
* Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
*/
var Later = class extends Error {};
/**
* Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
* Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
*/
var Effects = class {
	store;
	board;
	now;
	handlers = /* @__PURE__ */ new Map();
	health = /* @__PURE__ */ new Map();
	tasks = /* @__PURE__ */ new Set();
	/** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
	broken = /* @__PURE__ */ new Set();
	seq;
	scheduled = false;
	/** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
	started = false;
	stopped = false;
	constructor(store, board, now = () => Date.now()) {
		this.store = store;
		this.board = board;
		this.now = now;
		this.seq = Number(store.db.prepare("SELECT IFNULL(MAX(seq), 0) AS seq FROM effect").get()?.seq ?? 0);
	}
	/** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
	enqueue(kind, key, payload) {
		this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`).run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString());
		this.kick();
	}
	handle(kind, run, options = {}) {
		if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`);
		this.health.set(kind, this.board.claim(kind));
		const { limit = () => 1, retry = [2e3, 6e4], ordered = false, quiet = false } = options;
		this.handlers.set(kind, {
			run,
			limit: ordered ? () => Math.min(1, limit()) : limit,
			retry,
			ordered,
			quiet
		});
		this.report(kind);
		this.kick();
	}
	pending(kind, key) {
		return key === void 0 ? !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? LIMIT 1").get(kind) : !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? AND key = ?").get(kind, key);
	}
	/** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
	cancel(kind, key) {
		this.store.db.prepare("DELETE FROM effect WHERE kind = ? AND key = ?").run(kind, key);
		this.store.afterCommit(() => {
			this.report(kind);
		});
	}
	start() {
		this.started = true;
		this.kick();
	}
	kick() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.dispatch();
		});
	}
	/** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
	async idle(kind) {
		for (;;) {
			this.dispatch();
			const running = [...this.tasks].filter((task) => kind === void 0 || task.kind === kind).map((task) => task.done);
			if (!running.length) return;
			await Promise.allSettled(running);
		}
	}
	/** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
	async drain() {
		this.stopped = true;
		await Promise.allSettled([...this.tasks].map((task) => task.done));
	}
	dispatch() {
		if (!this.started || this.stopped) return;
		for (const [kind, handler] of this.handlers) try {
			const running = new Set([...this.tasks].filter((task) => task.kind === kind).map((task) => task.key));
			const rows = handler.ordered ? this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1").all(kind) : this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?").all(kind, this.now(), 16 + running.size);
			const ready = handler.ordered && running.size ? [] : rows.filter((row) => row.due <= this.now() && !running.has(row.key));
			let room = ready.length ? handler.limit() - running.size : 0;
			for (const row of ready) {
				if (room-- <= 0) break;
				this.run(kind, handler, row);
			}
			if (this.broken.delete(kind)) this.report(kind);
		} catch (error) {
			this.failed(kind, error);
		}
	}
	run(kind, handler, row) {
		const task = {
			kind,
			key: row.key,
			done: Promise.resolve()
		};
		task.done = this.attempt(kind, handler, row).catch((error) => {
			this.failed(kind, error);
		}).finally(() => {
			this.tasks.delete(task);
			this.kick();
		});
		this.tasks.add(task);
	}
	async attempt(kind, handler, row) {
		let failure;
		try {
			await handler.run(JSON.parse(row.value), row.key);
		} catch (error) {
			failure = { error };
		}
		const own = "kind = ? AND key = ? AND seq = ? AND generation = ?", ownRow = [
			kind,
			row.key,
			row.seq,
			row.generation
		];
		if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow);
		else if (this.stopped) return;
		else if (failure.error instanceof Later) this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow);
		else {
			const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16));
			this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`).run(String(failure.error).slice(0, 1e3), this.now() + delay, ...ownRow);
		}
		if (!this.stopped) this.report(kind);
	}
	failed(kind, error) {
		this.broken.add(kind);
		this.health.get(kind)?.set({
			state: "error",
			detail: `The effect queue failed: ${String(error)}`,
			at: new Date(this.now()).toISOString()
		});
	}
	report(kind) {
		const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind);
		const waiting = Number(row?.waiting ?? 0);
		const failing = Number(row?.attempts ?? 0) >= 3 && !this.handlers.get(kind)?.quiet;
		const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : "Nothing waiting";
		this.health.get(kind)?.set(failing ? {
			state: "error",
			detail: `${detail}; the last failure: ${String(row?.error)}`,
			at: new Date(this.now()).toISOString()
		} : {
			state: "ready",
			detail,
			at: new Date(this.now()).toISOString()
		});
	}
};
//#endregion
//#region src/executor/background.ts
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 1e4;
/** How long a release of subagents may take; it can hold up a shutdown, so DSH's own callers bound it too. */
const DRAIN_LIMIT_MS = 1e4;
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
const COLLECT_WAIT_MS = 6e5;
const registry = (ctx) => ctx.get("jobs");
const subagentsOf = (ctx) => ctx.get("subagents");
const running = (status) => status === "running" || status === "stopping";
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs, sessionId, except) => jobs.list(sessionId).filter((job) => job.owner === sessionId && running(job.status) && !except?.has(job.id));
/** `work`, or false once `signal` aborts or `ms` pass first. */
function until(work, signal, ms) {
	if (signal?.aborted) return Promise.resolve(false);
	let stop;
	const stopped = new Promise((resolve) => {
		stop = () => {
			resolve(false);
		};
	});
	signal?.addEventListener("abort", stop, { once: true });
	const timer = ms === void 0 ? void 0 : setTimeout(stop, ms);
	timer?.unref?.();
	return Promise.race([work, stopped]).finally(() => {
		signal?.removeEventListener("abort", stop);
		clearTimeout(timer);
	});
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
const cancelled = /* @__PURE__ */ new WeakSet();
/** The pending join of each worker's subagents, which DSH cannot cancel, so a later look joins the same one. */
const joins = /* @__PURE__ */ new WeakMap();
function childrenEnd(subagents, agent) {
	let join = joins.get(agent);
	if (!join) {
		join = subagents.waitForChildren(agent).finally(() => {
			joins.delete(agent);
		});
		joins.set(agent, join);
	}
	return join;
}
/** A job by its id and the first line of its label. */
const named = (job) => {
	const line = job.label?.split("\n")[0]?.trim();
	return line ? `${job.id} (${line})` : job.id;
};
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
const runningJobs = (ctx, sessionId, except) => {
	const jobs = registry(ctx);
	return jobs ? owned(jobs, sessionId, except).map((job) => ({
		id: job.id,
		name: named(job)
	})) : [];
};
/**
* Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
* no waiter on any job, so each job's end still reaches the worker.
*/
function jobsEnd(ctx, sessionId, signal, except) {
	const jobs = registry(ctx);
	if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			signal.removeEventListener("abort", aborted);
			resolve(value);
		};
		const aborted = () => {
			done(false);
		};
		const unsubscribe = jobs.events.subscribe({ owner: sessionId }, (event) => {
			if ((event.type === "settled" || event.type === "removed") && !owned(jobs, sessionId, except).length) done(true);
		});
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
	});
}
/**
* Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents. A job's or a
* subagent's end wakes the worker with its result, which ends this look: the turn it starts ends with an idle of its own,
* which looks afresh.
* @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
* as when the host stops or the look's time is up.
*/
async function untilQuiet(ctx, agent, signal, except) {
	for (;;) {
		const subagents = subagentsOf(ctx);
		const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false;
		const jobs = await jobsEnd(ctx, agent.id, signal, except);
		if (signal.aborted || agent.status !== "idle") return false;
		if (!children && !jobs) return true;
	}
}
/**
* Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
* One failure stops none other.
*/
async function killJobs(ctx, sessionId, reason, except) {
	const jobs = registry(ctx);
	const live = jobs ? owned(jobs, sessionId, except) : [];
	const failures = [];
	const collected = live.map((job) => jobs.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => void 0));
	for (const job of live) try {
		jobs.kill(job.id, sessionId, reason);
	} catch (error) {
		failures.push(error);
	}
	await Promise.all(collected);
	if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`);
}
/**
* Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
* @returns the job's name and status once it ended; undefined when `signal` aborted first.
*/
async function collectJob(ctx, sessionId, job, signal) {
	const jobs = registry(ctx);
	while (jobs && !signal.aborted) {
		const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => void 0);
		if (!view) return void 0;
		if (!running(view.status)) return {
			name: job.name,
			status: view.status
		};
	}
}
/**
* Release the worker's live subagents, for a bounded time. DSH delivers each one's end to the worker before the release
* returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
* with that turn. Its Session still admits subagents.
*/
async function stopSubagents(ctx, agent, keepInbox = false) {
	const subagents = subagentsOf(ctx);
	if (!subagents) return;
	const live = (await subagents.listChildren(agent.id)).map((child) => child.id).filter((id) => ctx.agents.get(id));
	if (!live.length) return;
	try {
		await until(subagents.drainChildren(agent, live), void 0, DRAIN_LIMIT_MS);
	} finally {
		if (agent.status !== "idle") cancelled.add(agent);
		agent.cancel({ kind: "user" }, { keepInbox });
		await until(agent.whenIdle(), void 0, DRAIN_LIMIT_MS);
	}
}
/**
* Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and release its subagents (see
* `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
*/
async function stopBackground(ctx, sessionId, reason, keepInbox = false) {
	const failures = [];
	await killJobs(ctx, sessionId, reason).catch((error) => {
		failures.push(error);
	});
	const agent = ctx.agents.get(sessionId);
	if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error) => {
		failures.push(error);
	});
	if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`);
}
//#endregion
//#region src/executor/dsh.ts
const now = () => (/* @__PURE__ */ new Date()).toISOString();
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
const workerSessionId = (ticketId) => `worker-${ticketId}`;
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
const ticketOfSession = (sessionId) => sessionId.startsWith("worker-") ? sessionId.slice(7) : void 0;
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 6e5;
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3;
const TRANSIENT_BACKOFF_MS = 15e3;
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 18e5;
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 1e4;
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5e3;
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input) => input?.kind === "trigger" ? !!input.human && !input.context : input?.kind === "text";
/**
* Internal error thrown when a ticket's workspace prepare command fails during launch.
* DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
*/
var PrepareFailed = class extends Error {};
const PASSING = new RegExp([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"EPIPE",
	"UND_ERR",
	"socket hang up",
	"fetch failed",
	"network error",
	"overloaded",
	"rate limit",
	"\\b(?:408|429|50[0-4])\\b"
].join("|"), "i");
/**
* True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
* connection that was refused, reset, timed out, or could not resolve its host.
*/
function transient(error) {
	const status = error?.status;
	if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
	const text = error instanceof Error ? `${error.name} ${error.message} ${String(error.code ?? "")}` : String(error);
	return PASSING.test(text);
}
/** Appends a stable 12-character ticket ID suffix to a conservative cross-platform directory name. */
const ticketWorktreeName = (name, id) => {
	const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
	if (!safe || safe === "." || safe === "..") throw new Error("A ticket needs a safe directory name");
	return `${safe}-${id.slice(0, 12)}`;
};
/** 公司执行层的报告消息；目标会话由 Sessions 按 ticket_id 从 Trigger 元数据解析。 */
function resultRelay(ticket, state, summary) {
	return {
		id: `report:${ticket.id}:${ticket.updatedAt}`,
		text: JSON.stringify({
			kind: "worker_report",
			ticket_id: ticket.id,
			state,
			summary
		})
	};
}
/** Looks up a ticket's origin trigger in Store. */
const sourceTrigger = (host, ticket) => host.store.triggers.get(ticket.origin.triggerId);
/**
* Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
* rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
*/
function mandateInstructions(mandate) {
	return mandate.strength === "inferred" ? "This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope." : "";
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
function ticketExecution(ticket, outcome, settings, stateDir) {
	const name = ticketWorktreeName(outcome.name ?? "", ticket.id);
	ticket.origin.triggerId;
	const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : "";
	const ruleIds = ticket.mandate.basis.rules;
	const rules = settings.policy.rules.filter((rule) => ruleIds?.includes(rule.id)).map((rule) => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join("");
	const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : "";
	const assignment = ticket.mandate.strength === "inferred" && ruleIds ? `Proactively accepted under ${ruleIds.join(", ")}. Scope: ${outcome.scope}.${precedence}${note}` : note.trim();
	return {
		name,
		directory: join(executionRoot(settings, stateDir), name),
		assignment
	};
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500;
const TRIGGER_CHARS = 600;
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text, limit, read) => text.length <= limit ? { text } : {
	text: `${text.slice(0, limit)}…`,
	chars: text.length,
	read
};
/**
* Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
* optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
*/
function triggerMessage(trigger, link, note, repliesTo) {
	return {
		trigger_id: trigger.id,
		from: trigger.actor.id,
		thread: threadKey(trigger.threads[0]),
		at: trigger.at,
		...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`),
		...link,
		...note ? { routing_note: note } : {},
		...repliesTo ? { replies_to: {
			trigger_id: repliesTo.id,
			preview: repliesTo.text.replace(/\s+/g, " ").slice(0, 160)
		} } : {}
	};
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
const batchLine = (trigger) => ({
	trigger_id: trigger.id,
	from: trigger.actor.id,
	at: trigger.at,
	preview: trigger.text.replace(/\s+/g, " ").slice(0, 160),
	read: `trigger/${trigger.id}`
});
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
const batchOf = (host, ticket) => ticket.origin.triggerIds.filter((id) => id !== ticket.origin.triggerId).flatMap((id) => host.store.triggers.get(id) ?? []);
const RESUMED = "This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.";
const RETRIED = "A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.";
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect) {
	if (!effect) return "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.";
	return [
		"Policy change:",
		...(effect.rules ?? []).map((rule) => rule.change === "disabled" ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.` : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
		...effect.proactive === false ? ["Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new."] : [],
		...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : "who asked for it"}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []
	].join("\n");
}
/** Resource path under which a worker session reads the full text of a ticket input. */
const inputResource = (ticketId, inputId) => `ticket/${ticketId}/input/${key(inputId)}`;
/**
* Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
* a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
* Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
*/
function inputMessage(input, trigger) {
	if (input.kind === "trigger") return JSON.stringify({
		...trigger ?? {
			trigger_id: input.triggerId,
			read: `trigger/${input.triggerId}`
		},
		...input.context ? { context: true } : {}
	});
	if (input.kind === "policy-changed") return policyMessage(input.effect);
	if (input.kind === "resumed") return RESUMED;
	if (input.kind === "note") return `Note from the orchestrator, for context only: ${input.text}`;
	return input.kind === "text" ? input.text : void 0;
}
/**
* Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
* worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
* DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
* and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
*/
var WorkerSlots = class {
	running;
	max;
	/** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
	starting = /* @__PURE__ */ new Map();
	/**
	* @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
	* @param max - Returns the configured maximum number of concurrent worker slots.
	*/
	constructor(running, max) {
		this.running = running;
		this.max = max;
	}
	/** Number of slots currently in use across running workers and starting reservations. */
	used() {
		return (/* @__PURE__ */ new Set([...this.running(), ...this.starting.keys()])).size;
	}
	/** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
	launches() {
		const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== "launch" ? [ticketId] : []);
		return this.max() - (/* @__PURE__ */ new Set([...this.running(), ...wakes])).size;
	}
	/**
	* Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
	* A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
	* Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
	* @throws Later when no slot is free.
	*/
	reserve(ticketId, by) {
		if (this.starting.has(ticketId)) return;
		if (this.used() >= this.max() + (by === "person" ? 1 : 0)) throw new Later("No worker slot is free");
		this.starting.set(ticketId, by);
	}
	/** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
	free(ticketId) {
		this.starting.delete(ticketId);
	}
};
/**
* Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
* Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
* `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
* Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
*/
var DshExecutor = class {
	host;
	disposers = [];
	slots;
	/** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
	transient = /* @__PURE__ */ new Map();
	/** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
	resuming = /* @__PURE__ */ new Set();
	/**
	* The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
	* runs again or its Assignment ends.
	*/
	settling = /* @__PURE__ */ new Map();
	/** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
	stopping = /* @__PURE__ */ new Map();
	/** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
	left = /* @__PURE__ */ new Map();
	/** When a person's message typed into a worker's Session last started a turn, by ticket. */
	personal = /* @__PURE__ */ new Map();
	/** The timers of workers that go on after a passing failure, which dispose clears. */
	timers = /* @__PURE__ */ new Set();
	/** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
	constructor(host) {
		this.host = host;
		this.slots = new WorkerSlots(() => host.store.tickets.open().filter((ticket) => this.running(ticket)).map((ticket) => ticket.id), () => host.store.settings().executor.maxWorkers);
		host.effects.handle("launch", (payload) => this.launchQueued(payload), {
			limit: () => host.paused() ? 0 : this.slots.launches(),
			retry: [5e3, 3e5]
		});
		host.effects.handle("delivery", (payload) => this.deliverQueued(payload.ticketId), {
			limit: () => host.paused() ? 0 : 4,
			quiet: true
		});
	}
	/** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
	prepare(ticket, outcome) {
		return {
			...ticket,
			execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir)
		};
	}
	/**
	* Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
	* execution environment variables, then verifies the directory as the worker sees it.
	* A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
	* @throws PrepareFailed with the command's output when the prepare command fails.
	*/
	async prepareDirectory(ticket) {
		const directory = ticket.execution?.directory ?? "";
		await mkdir(dirname(directory), { recursive: true });
		const command = this.host.store.settings().executor.prepare.trim();
		const env = Object.fromEntries(this.host.environment(ticket).map((variable) => [variable.key, variable.value]));
		const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]);
		if (command) {
			const argv = process.platform === "win32" ? [
				"pwsh",
				"-NoProfile",
				"-Command",
				command
			] : [
				"sh",
				"-c",
				command
			];
			await runAsWorker(this.host.context.subprocess, argv, dirname(directory), signal, env).catch(async (error) => {
				await rmdir(directory).catch(() => {});
				throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		await mkdir(directory, { recursive: true });
		await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime);
	}
	/** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
	start(ticket, assignment) {
		this.host.effects.enqueue("launch", assignment.id, {
			ticketId: ticket.id,
			assignmentId: assignment.id
		});
	}
	/** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
	deliver(ticket, _assignment) {
		this.host.effects.enqueue("delivery", ticket.id, { ticketId: ticket.id });
	}
	/** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
	async launchQueued({ ticketId, assignmentId }) {
		const ticket = this.host.store.tickets.get(ticketId);
		const assignment = ticket && latestAssignment(ticket);
		if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== "pending") return;
		this.slots.reserve(ticketId, "launch");
		try {
			await this.launch(ticket, assignment);
			this.transient.delete(`launch:${assignmentId}`);
		} catch (error) {
			if (this.host.closing() || error instanceof Later) throw error;
			if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error;
			this.launchFailed(ticketId, assignmentId, error);
		} finally {
			this.slots.free(ticketId);
		}
	}
	/**
	* Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
	* stops immediately if the ticket ended or another assignment took over.
	*/
	async deliverQueued(ticketId) {
		await this.stopped(ticketId);
		const first = this.host.store.tickets.get(ticketId);
		const target = first && liveTicket(first) ? runningAssignment(first) : void 0;
		if (!first || !target || !first.undelivered.length) return;
		let woken = false;
		try {
			for (;;) {
				const ticket = this.host.store.tickets.get(ticketId);
				const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : void 0;
				const inputId = ticket?.undelivered[0];
				if (!ticket || !assignment || inputId === void 0) return;
				const sessionId = workerSessionId(ticketId);
				if (!woken && !this.running(ticket)) {
					const person = ticket.undelivered.some((id) => fromPerson(ticket.inputs.find((item) => item.id === id)));
					this.slots.reserve(ticketId, person ? "person" : "wake");
					woken = true;
				}
				const input = ticket.inputs.find((item) => item.id === inputId);
				try {
					if (!this.host.context.agents.get(sessionId)) await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? "", ticket.title, "worker");
					if (input) await this.deliverInput(ticket, assignment, input);
				} catch (error) {
					if (this.host.closing() || error instanceof Later) throw error;
					const current = this.host.store.tickets.get(ticketId);
					if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return;
					this.host.engine.deliveryFailed(ticketId, assignment.id, String(error));
					throw error;
				}
				this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId]);
			}
		} finally {
			if (woken) this.slots.free(ticketId);
		}
	}
	async deliverInput(ticket, assignment, input) {
		const live = () => {
			const current = this.host.store.tickets.get(ticket.id);
			if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error("The ticket ended or another Assignment took it over");
			if (this.stopping.has(ticket.id)) throw new Later("The worker's background work is stopping");
		};
		live();
		const message = inputMessage(input, input.kind === "trigger" ? await this.triggerCard(ticket, input.triggerId, input.note) : void 0);
		if (message === void 0) return;
		const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message;
		await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, "steer", live);
	}
	/** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
	async triggerCard(ticket, triggerId, note) {
		const trigger = this.host.store.triggers.get(triggerId);
		if (!trigger) return void 0;
		const parent = this.host.repliedTo(trigger);
		const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === parent.id));
		return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? void 0 : parent);
	}
	/**
	* After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
	* starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
	* report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
	*/
	stop(ticket, assignment, reason) {
		this.transient.delete(assignment.id);
		this.transient.delete(`launch:${assignment.id}`);
		const report = assignment.report;
		const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at;
		const ownTurn = (report?.state === "ready" || report?.state === "dropped") && !busy;
		const sessionId = workerSessionId(ticket.id);
		this.host.store.afterCommit(() => {
			this.settling.get(ticket.id)?.abort();
			if (!ownTurn) this.host.context.agents.get(sessionId)?.cancel({ kind: "user" }, { keepInbox: false });
			this.stopWork(ticket.id, reason);
			this.left.get(ticket.id)?.collect.abort();
			this.left.delete(ticket.id);
			this.personal.delete(ticket.id);
		});
	}
	/** Stop what a ticket's worker runs in the background (see `stopBackground`). */
	stopWork(ticketId, reason, keepInbox = false) {
		this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox));
	}
	/** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
	track(ticketId, stop) {
		const entry = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {}).finally(() => {
			if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId);
		});
		this.stopping.set(ticketId, entry);
		this.background(stop);
	}
	/** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
	async stopped(ticketId) {
		const stopping = this.stopping.get(ticketId);
		if (stopping) await until(stopping, this.host.lifetime);
	}
	/**
	* On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
	* of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
	*/
	async shutdown() {
		const agents = this.host.store.tickets.list().map((ticket) => this.host.context.agents.get(workerSessionId(ticket.id))).filter((agent) => agent !== void 0);
		const stop = async () => {
			await Promise.allSettled(agents.map((agent) => stopBackground(this.host.context, agent.id, "dsh-superagent stopped", true)));
			for (const { collect } of this.left.values()) collect.abort();
			const running = agents.filter((agent) => agent.status !== "idle");
			for (const agent of running) agent.cancel({ kind: "user" }, { keepInbox: true });
			await Promise.allSettled(running.map((agent) => agent.whenIdle()));
		};
		await until(stop(), void 0, SHUTDOWN_STOP_MS);
	}
	/** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
	activeCount() {
		return this.host.store.tickets.open().filter((ticket) => this.running(ticket)).length;
	}
	/** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
	running(ticket) {
		if (!runningAssignment(ticket)) return false;
		return this.host.context.agents.get(workerSessionId(ticket.id))?.status === "running" || this.settling.has(ticket.id);
	}
	/** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
	launchFailed(ticketId, assignmentId, error) {
		const ticket = this.host.store.tickets.get(ticketId);
		if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return;
		this.failed(ticketId, String(error));
	}
	/** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
	failed(ticketId, summary) {
		this.host.store.atomic(() => {
			const updated = this.host.engine.report(ticketId, {
				state: "failed",
				summary
			});
			this.relay(resultRelay(updated, "failed", summary));
		});
	}
	relay({ id, text }) {
		this.host.sessions.relay(id, text);
	}
	async launch(ticket, assignment) {
		const current = () => {
			if (this.host.closing()) throw new Error("dsh-superagent is stopping");
			if (this.host.paused()) throw new Later("Processing is paused");
			const stored = this.host.store.tickets.get(ticket.id);
			return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id;
		};
		const source = sourceTrigger(this.host, ticket);
		const workspace = ticket.execution?.directory ?? "";
		if (!current()) return;
		if (!await stat(workspace).then(() => true, () => false)) {
			await this.prepareDirectory(ticket);
			if (!current()) return;
		}
		if (!current()) return;
		const sessionId = workerSessionId(ticket.id);
		const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, "worker");
		if (!current()) return;
		await this.stopped(ticket.id);
		if (!current()) return;
		for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id));
		const first = `assignment:${ticket.id}`;
		const later = ticket.assignments.length > 1;
		const told = later && await this.host.sessions.holds(sessionId, first);
		if (!current()) return;
		const retried = ticket.assignments.at(-2)?.endedReason === "retried" ? { note: RETRIED } : {};
		const assignmentText = ticket.execution?.assignment ?? "";
		const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`);
		const card = told || !source ? void 0 : await this.triggerCard(ticket, source.id);
		if (!current()) return;
		const batch = told ? [] : batchOf(this.host, ticket).map(batchLine);
		const text = told ? JSON.stringify({
			ticket_id: ticket.id,
			assignment: ticket.assignments.length,
			...retried
		}) : JSON.stringify({
			ticket_id: ticket.id,
			title: ticket.title,
			...brief ? { assignment: brief } : {},
			...read ? {
				assignment_chars: chars,
				assignment_read: read
			} : {},
			...card ? { trigger: card } : {},
			...batch.length ? { batch } : {},
			...retried
		});
		const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first;
		await this.host.sessions.prompt(sessionId, requestId, text, "queue", () => {
			if (!current()) throw new Error("Launch authorization changed before worker delivery");
		}, () => {
			this.host.engine.assignmentStarted(ticket.id, assignment.id);
		});
		this.host.engine.assignmentStarted(ticket.id, assignment.id);
	}
	/** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
	ticketOf(agent) {
		const ticketId = ticketOfSession(agent.id);
		return ticketId === void 0 ? void 0 : this.host.store.tickets.get(ticketId);
	}
	/** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
	install() {
		const ctx = this.host.context;
		this.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
			if (status === "running") {
				this.settling.get(ticketOfSession(agent.id) ?? "")?.abort();
				return;
			}
			if (status !== "idle" || cancelled.delete(agent) || this.host.closing()) return;
			const ticket = this.ticketOf(agent);
			const assignment = ticket && runningAssignment(ticket);
			if (ticket && assignment && liveTicket(ticket)) this.background(this.workerIdle(ticket, assignment, agent));
		}));
		this.disposers.push(ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const ticketId = ticketOfSession(agent.id);
			if (ticketId !== void 0 && message.source.kind === "user") this.personal.set(ticketId, now());
		}));
		this.disposers.push(ctx.on("session/event", (session, event) => {
			const ticketId = ticketOfSession(session.id);
			if (event.type !== "user/message" || ticketId === void 0 || event.data.source.kind !== "dsh-superagent" || this.host.closing()) return;
			const message = event.data;
			this.background(Promise.resolve().then(() => {
				const read = this.host.store.tickets.get(ticketId)?.inputs.filter((input) => input.kind === "trigger" && !input.readAt && this.host.sessions.promptedId(input.id) === message.id).map((input) => input.id) ?? [];
				if (read.length) this.host.engine.inputsRead(ticketId, read);
			}));
		}));
		this.disposers.push(ctx.on("agent/error", ({ agent, error }) => {
			const ticket = this.ticketOf(agent);
			const assignment = ticket && runningAssignment(ticket);
			if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return;
			if (this.retries(assignment.id, error)) {
				this.resumeAfter(ticket.id, assignment.id, error);
				return;
			}
			this.background(Promise.resolve().then(() => {
				this.failed(ticket.id, String(error));
			}));
		}));
	}
	/** Unsubscribes from host agent events and clears any pending transient-retry timers. */
	dispose() {
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
	/**
	* Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
	* running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
	* while failed launches (`waitsForPerson`) wait for a person's message or a retry.
	*/
	resume() {
		for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			const running = runningAssignment(ticket), latest = latestAssignment(ticket);
			if (running) {
				this.host.context.agents.get(workerSessionId(ticket.id))?.cancel({ kind: "user" }, { keepInbox: true });
				this.stopWork(ticket.id, "dsh-superagent restarted", true);
				this.host.engine.assignmentInterrupted(ticket.id, running.id);
			} else if (latest?.state === "pending" && !waitsForPerson(ticket)) this.start(ticket, latest);
		}
	}
	/** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
	background(work) {
		const { health } = this.host;
		return work.then(() => {
			if (health.get()?.state === "error") health.set({
				state: "ready",
				detail: "Worker events are handled",
				at: now()
			});
		}, (error) => {
			health.set({
				state: "error",
				detail: String(error),
				at: now()
			});
		});
	}
	/**
	* Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
	* increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
	*/
	retries(key, error) {
		const tries = this.transient.get(key) ?? 0;
		if (!transient(error) || tries >= TRANSIENT_TRIES) {
			this.transient.delete(key);
			return false;
		}
		this.transient.set(key, tries + 1);
		return true;
	}
	/** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
	resumeAfter(ticketId, assignmentId, error) {
		const tries = this.transient.get(assignmentId);
		const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`;
		this.resuming.add(assignmentId);
		const go = () => {
			if (this.host.closing()) return;
			const ticket = this.host.store.tickets.get(ticketId);
			if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) {
				this.resuming.delete(assignmentId);
				return;
			}
			if (this.host.paused()) {
				this.after(SLOT_WAIT_MS, go);
				return;
			}
			const sessionId = workerSessionId(ticketId);
			const waking = !this.running(ticket);
			try {
				if (waking) this.slots.reserve(ticketId, "wake");
			} catch (failure) {
				if (!(failure instanceof Later)) throw failure;
				this.after(SLOT_WAIT_MS, go);
				return;
			}
			const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, "queue");
			this.background(sent.finally(() => {
				if (waking) this.slots.free(ticketId);
				this.resuming.delete(assignmentId);
			}).catch((failure) => {
				this.failed(ticketId, String(failure));
			}));
		};
		this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go);
	}
	/** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
	after(ms, then) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			then();
		}, ms);
		timer.unref?.();
		this.timers.add(timer);
	}
	/**
	* A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
	* person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
	* collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
	*/
	handOff(ticketId, agent) {
		this.track(ticketId, stopSubagents(this.host.context, agent, true));
		const left = this.left.get(ticketId) ?? {
			jobs: /* @__PURE__ */ new Set(),
			collect: new AbortController()
		};
		this.left.set(ticketId, left);
		for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
			left.jobs.add(job.id);
			this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async (ended) => {
				if (!ended) return;
				const note = `Your background job ${ended.name} ended: ${ended.status}.`;
				await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: "Background job ended" });
			}));
		}
	}
	async workerIdle(ticket, idle, agent) {
		await agent.whenIdle();
		if (this.resuming.has(idle.id) || agent.status !== "idle") return;
		this.transient.delete(idle.id);
		const live = () => {
			const stored = this.host.store.tickets.get(ticket.id);
			return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : void 0;
		};
		const handedOff = (stored) => {
			const assignment = runningAssignment(stored), report = assignment?.report;
			const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at;
			return (report?.state === "ready" || !!stored.attention) && !since || waitsForPerson(stored);
		};
		const before = live();
		if (!before || this.host.closing()) return;
		const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id);
		if (handedOff(before) && !(report && person && person > report.at)) {
			this.host.engine.turnEnded(ticket.id, idle.id);
			this.handOff(ticket.id, agent);
			return;
		}
		this.settling.get(ticket.id)?.abort();
		const look = new AbortController(), limit = new AbortController();
		this.settling.set(ticket.id, look);
		const timer = setTimeout(() => {
			limit.abort();
		}, BACKGROUND_LIMIT_MS);
		timer.unref?.();
		let quiet;
		const left = this.left.get(ticket.id)?.jobs;
		try {
			quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([
				this.host.lifetime,
				look.signal,
				limit.signal
			]), left);
		} finally {
			clearTimeout(timer);
			if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id);
		}
		const current = live();
		if (this.host.closing() || look.signal.aborted || !quiet && !limit.signal.aborted || !current || this.resuming.has(idle.id)) return;
		if (quiet) this.host.engine.turnEnded(ticket.id, idle.id);
		let stopped = "";
		if (!quiet) {
			const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 6e4;
			const jobs = runningJobs(this.host.context, sessionId, left).map((job) => job.name);
			if (jobs.length) {
				this.background(killJobs(this.host.context, sessionId, "The job ran past its limit", left));
				const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(", ")}.`;
				this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(",")}`, note, { inject: "Background jobs killed" }));
			}
			stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(", ")}.` : `Subagents still ran ${minutes} minutes after the worker's turn ended.`;
		}
		if (handedOff(current)) return;
		const last = agent.session.snapshotEvents().filter((event) => event.type === "assistant/message").at(-1);
		const said = [last?.type === "assistant/message" ? last.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim() : "", stopped].filter(Boolean).join("\n\n");
		this.host.store.atomic(() => {
			const before = latestReport(current)?.summary ?? "";
			const updated = this.host.engine.report(ticket.id, {
				state: "waiting",
				summary: said || before
			});
			if (said) this.relay(resultRelay(updated, "waiting", said));
			else if (!before.trim()) this.relay(resultRelay(updated, "waiting", "Worker ended without a status report. Use orchestrator_ticket_request_status to request one."));
		});
	}
};
//#endregion
//#region src/app/role-models.ts
/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
async function resolveRoleModel(ctx, model) {
	const value = await ctx.llm.resolveCallConfig({
		provider: model.provider,
		model: model.model,
		...model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}
	});
	return {
		provider: value.provider,
		model: value.model,
		...value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}
	};
}
/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
async function initializeRoleModel(ctx, agent, model) {
	if (!model) return;
	if (agent.session.requestHeader() || agent.session.snapshotEvents().some((event) => event.type === "model/selection")) return;
	const selected = await resolveRoleModel(ctx, model);
	agent.session.append("model/selection", selected);
	let initial = true;
	let assembled;
	agent.ctx.effect(() => {
		const disposers = [
			agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
				const selection = initial ? selected : void 0;
				const result = await next();
				assembled = selection;
				return selection ? {
					...result,
					variables: {
						...result.variables,
						provider: selection.provider,
						model: selection.model
					}
				} : result;
			}, { prepend: true }),
			agent.ctx.on("agent/request", async (_payload, next) => {
				const result = await next();
				if (!assembled) return result;
				const { reasoningEffort: _inherited, ...rest } = result;
				return {
					...rest,
					...assembled
				};
			}, { prepend: true }),
			ctx.on("session/event", (session, event) => {
				if (session === agent.session && (event.type === "request/header" || event.type === "model/selection")) initial = false;
			})
		];
		return () => disposers.forEach((dispose) => dispose());
	});
	await ctx.sessionPersistence.flush();
}
//#endregion
//#region \0@oxc-project+runtime@0.148.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/app/delivery.ts
/** The id of the message delivered under `requestId`, the same on every retry. */
const messageId = (requestId) => MessageId(`dsh-superagent:${requestId}`);
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message) {
	const source = message.source;
	if (source.kind === "dsh-superagent" || source.kind === "plugin" && source.plugin === "dsh-superagent") return message.id;
	if (source.kind === "user" && "rpcId" in source && typeof source.rpcId === "string") return messageId(source.rpcId);
}
/**
* Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
* Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
* and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
*/
var AgentDelivery = class {
	ctx;
	seen = /* @__PURE__ */ new WeakMap();
	constructor(ctx) {
		this.ctx = ctx;
		ctx.on("session/event", (session, event) => {
			if (event.type !== "user/message") return;
			const id = deliveryId(event.data);
			if (id) this.seen.get(session)?.ids.add(id);
		});
	}
	async history(agent) {
		let seen = this.seen.get(agent.session);
		if (!seen) {
			seen = { ids: /* @__PURE__ */ new Set() };
			this.seen.set(agent.session, seen);
		}
		const state = seen;
		state.loaded ??= (async () => {
			try {
				var _usingCtx$1 = _usingCtx();
				await this.ctx.sessionPersistence.flush();
				const handle = _usingCtx$1.a(await this.ctx.sessionPersistence.open(agent.id, "read"));
				for (let offset = 0;;) {
					const { events } = await handle.read(offset, 512);
					if (!events.length) break;
					for (const event of events) {
						if (event.type !== "user/message") continue;
						const id = deliveryId(event.data);
						if (id) state.ids.add(id);
					}
					offset += events.length;
				}
			} catch (_) {
				_usingCtx$1.e = _;
			} finally {
				await _usingCtx$1.d();
			}
		})().catch((error) => {
			state.loaded = void 0;
			throw error;
		});
		await state.loaded;
		return state;
	}
	async holds(agent, requestId) {
		const id = messageId(requestId);
		return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => deliveryId(message) === id);
	}
	/** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
	async send(agent, requestId, text, mode, signal, authorize, accepted) {
		signal.throwIfAborted();
		const seen = await this.history(agent);
		signal.throwIfAborted();
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error("Delivery target was disposed");
		authorize?.();
		const id = messageId(requestId);
		const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => deliveryId(message) === id);
		if (!seen.ids.has(id) && !pending) {
			const source = typeof mode === "object" ? {
				kind: "dsh-superagent",
				form: "notice",
				summary: mode.inject
			} : {
				kind: "dsh-superagent",
				form: "relay"
			};
			const message = freezeMessage({
				id,
				role: "user",
				content: [{
					type: "text",
					text
				}],
				source
			});
			if (typeof mode === "object") {
				agent.inject(message);
				seen.ids.add(id);
			} else if (mode === "steer") agent.steer(message);
			else agent.followup(message);
		}
		accepted?.();
		await this.ctx.sessionPersistence.flush();
	}
};
//#endregion
export { said as C, UserError as D, USER_ERRORS as E, reasonText as S, ticketStage as T, Later as _, DshExecutor as a, Engine as b, batchOf as c, mandateInstructions as d, sourceTrigger as f, Effects as g, workerSessionId as h, resolveRoleModel as i, inputMessage as l, triggerMessage as m, messageId as n, WorkerSlots as o, ticketOfSession as p, initializeRoleModel as r, batchLine as s, AgentDelivery as t, inputResource as u, HealthBoard as v, canRetry as w, REASONS as x, MemoryRepositories as y };
