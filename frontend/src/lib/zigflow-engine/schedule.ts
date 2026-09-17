/**
 * The workflow-level schedule, as the builder models it, and its lossless mapping onto the DSL.
 *
 * Zigflow splits one user-facing concept across two places in the document, and this file is the
 * only thing that knows that:
 *
 * ```yaml
 * document:
 *   metadata:
 *     scheduleWorkflowName: my-workflow   # required by zigflow whenever `schedule:` is set
 *     scheduleId: some-schedule           # optional; defaults to `zigflow_<workflowType>`
 *     scheduleInput:                      # optional; Temporal workflow *arguments*, hence a list
 *       - { ... }
 * schedule:                               # the spec itself — `cron`, `every`, or both
 *   cron: "0 0 * * *"
 * ```
 *
 * Turning a schedule **off** means removing `schedule:` entirely: `zigflow run` deletes the
 * matching Temporal schedule on every worker start and only recreates it when the block is
 * present, so an `enabled: false` flag in the DSL would do nothing. To avoid silently discarding
 * the user's cron/interval when they flick the toggle, the whole configuration is parked under our
 * own `document.metadata.duraflow.disabledSchedule` key instead — exactly one of the two
 * representations exists at a time, so there is never a second source of truth to disagree with.
 */

import type { DurationFields, ScheduleSpec, ZigflowDocument } from './ast';

export const SCHEDULE_METADATA_KEYS = {
	workflowName: 'scheduleWorkflowName',
	id: 'scheduleId',
	input: 'scheduleInput'
} as const;

/** Our own namespace inside `document.metadata`, for state the Zigflow DSL has nowhere to put. */
export const DURAFLOW_METADATA_KEY = 'duraflow';
export const DISABLED_SCHEDULE_KEY = 'disabledSchedule';

export interface WorkflowSchedule {
	enabled: boolean;
	/** Fire on a fixed interval (`schedule.every`). */
	useInterval: boolean;
	every: DurationFields;
	/** Fire on a cron expression (`schedule.cron`), evaluated by Temporal in UTC. */
	useCron: boolean;
	cron: string;
	/** `document.metadata.scheduleId` — blank means zigflow's default, `zigflow_<workflowType>`. */
	scheduleId: string;
	/** `document.metadata.scheduleWorkflowName` — blank means "this document's `workflowType`". */
	workflowName: string;
	/** The single argument each scheduled run starts with; `null` means none is configured. */
	input: Record<string, unknown> | null;
}

/**
 * The "no schedule here" value. Both spec flags start off and `cron`/`every` are inert drafts, so
 * a workflow that has never been scheduled serializes to a document with no schedule keys at all —
 * opening the builder must not add `duraflow.disabledSchedule` to every DSL in the system.
 */
export function defaultWorkflowSchedule(): WorkflowSchedule {
	return {
		enabled: false,
		useInterval: false,
		every: { minutes: 5 },
		useCron: false,
		cron: '0 0 * * *',
		scheduleId: '',
		workflowName: '',
		input: null
	};
}

/** True once the schedule would actually fire — an enabled schedule with neither spec never does. */
export function isScheduleActive(schedule: WorkflowSchedule | undefined): boolean {
	if (!schedule?.enabled) return false;
	return (
		(schedule.useCron && schedule.cron.trim() !== '') ||
		(schedule.useInterval && hasInterval(schedule.every))
	);
}

export function hasInterval(every: DurationFields | undefined): boolean {
	if (!every) return false;
	return Object.values(every).some((v) => (typeof v === 'number' ? v > 0 : Boolean(v)));
}

/** Drops zero/blank components — `{ minutes: 5, seconds: 0 }` is written as `{ minutes: 5 }`. */
export function compactDuration(every: DurationFields | undefined): DurationFields {
	const out: DurationFields = {};
	for (const [key, value] of Object.entries(every ?? {})) {
		if (typeof value === 'number' ? value > 0 : Boolean(value)) {
			(out as Record<string, unknown>)[key] = value;
		}
	}
	return out;
}

// ── Document -> UI model ─────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** `scheduleInput` is a Temporal argument *list*; the builder authors the single argument in it. */
function readScheduleInput(value: unknown): Record<string, unknown> | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	return asRecord(value[0]);
}

export function readWorkflowSchedule(doc: ZigflowDocument): WorkflowSchedule {
	const metadata = doc.document.metadata ?? {};
	const base = defaultWorkflowSchedule();

	if (doc.schedule) {
		const every = compactDuration(doc.schedule.every);
		const cron = asString(doc.schedule.cron);
		return {
			enabled: true,
			useInterval: Object.keys(every).length > 0,
			every: Object.keys(every).length > 0 ? every : base.every,
			useCron: cron !== '',
			cron: cron || base.cron,
			scheduleId: asString(metadata[SCHEDULE_METADATA_KEYS.id]),
			workflowName: asString(metadata[SCHEDULE_METADATA_KEYS.workflowName]),
			input: readScheduleInput(metadata[SCHEDULE_METADATA_KEYS.input])
		};
	}

	const parked = asRecord(asRecord(metadata[DURAFLOW_METADATA_KEY])?.[DISABLED_SCHEDULE_KEY]);
	if (!parked) return base;

	const every = compactDuration((asRecord(parked.every) as DurationFields | null) ?? undefined);
	const cron = asString(parked.cron);
	return {
		enabled: false,
		useInterval: parked.useInterval === true,
		every: Object.keys(every).length > 0 ? every : base.every,
		useCron: parked.useCron === true,
		cron: cron || base.cron,
		scheduleId: asString(parked.scheduleId),
		workflowName: asString(parked.workflowName),
		input: asRecord(parked.input)
	};
}

// ── UI model -> document ─────────────────────────────────────────────────

export interface ScheduleDocumentParts {
	/** The top-level `schedule:` block, or undefined when the schedule is off. */
	schedule?: ScheduleSpec;
	/** `document.metadata`, or undefined when nothing is left in it. */
	metadata?: Record<string, unknown>;
}

/**
 * Folds `schedule` back into the document, preserving every unrelated key already in `metadata`.
 * `workflowType` supplies the default for `scheduleWorkflowName`, which zigflow requires and
 * refuses to infer (`workflow name not set for schedule`).
 */
export function applyWorkflowSchedule(
	schedule: WorkflowSchedule | undefined,
	metadata: Record<string, unknown> | undefined,
	workflowType: string
): ScheduleDocumentParts {
	const rest = { ...(metadata ?? {}) };
	for (const key of Object.values(SCHEDULE_METADATA_KEYS)) delete rest[key];

	// Our namespace is shared with anything else duraflow may park there later, so edit it rather
	// than replace it, and drop it entirely once it holds nothing.
	const duraflow = { ...(asRecord(rest[DURAFLOW_METADATA_KEY]) ?? {}) };
	delete duraflow[DISABLED_SCHEDULE_KEY];
	delete rest[DURAFLOW_METADATA_KEY];

	const every = compactDuration(schedule?.every);
	const cron = (schedule?.cron ?? '').trim();

	if (schedule && isScheduleActive(schedule)) {
		const spec: ScheduleSpec = {
			...(schedule.useInterval && Object.keys(every).length > 0 ? { every } : {}),
			...(schedule.useCron && cron !== '' ? { cron } : {})
		};
		rest[SCHEDULE_METADATA_KEYS.workflowName] = schedule.workflowName || workflowType;
		if (schedule.scheduleId) rest[SCHEDULE_METADATA_KEYS.id] = schedule.scheduleId;
		if (schedule.input) rest[SCHEDULE_METADATA_KEYS.input] = [schedule.input];
		return { schedule: spec, metadata: finalize(rest, duraflow) };
	}

	// Off, but configured: park it so the toggle is reversible without retyping the cron.
	if (schedule && (schedule.useCron || schedule.useInterval || schedule.input)) {
		duraflow[DISABLED_SCHEDULE_KEY] = {
			useCron: schedule.useCron,
			useInterval: schedule.useInterval,
			...(cron !== '' ? { cron } : {}),
			...(Object.keys(every).length > 0 ? { every } : {}),
			...(schedule.scheduleId ? { scheduleId: schedule.scheduleId } : {}),
			...(schedule.workflowName ? { workflowName: schedule.workflowName } : {}),
			...(schedule.input ? { input: schedule.input } : {})
		};
	}

	return { metadata: finalize(rest, duraflow) };
}

function finalize(
	rest: Record<string, unknown>,
	duraflow: Record<string, unknown>
): Record<string, unknown> | undefined {
	if (Object.keys(duraflow).length > 0) rest[DURAFLOW_METADATA_KEY] = duraflow;
	return Object.keys(rest).length > 0 ? rest : undefined;
}
