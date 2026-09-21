import type { Node, Edge } from '@xyflow/svelte';
import type {
	EventConsumptionStrategy,
	EventFilter,
	FlowDirective,
	ForkTask,
	ForTask,
	InputConfig,
	PullPolicy,
	RaiseTask,
	RunConfig,
	RunTask,
	SwitchCase,
	SwitchCaseBody,
	SwitchTask,
	TaskList,
	TaskNode,
	TryTask,
	WaitTask,
	ZigflowDocument,
	ZigflowDocumentHeader
} from './ast';
import type {
	VarEntry,
	CaseEntry,
	CaseRouting,
	EventEntry,
	BranchEntry
} from '../components/builder/builderConfig';
import type { WorkflowNodeType, InputField } from '../types';
import { applyWorkflowSchedule, readWorkflowSchedule, type WorkflowSchedule } from './schedule';
import { toSlug, toTaskName, uniqueTaskName } from './slug';
import { orderNodesInScope, layoutScope } from './layout';
import {
	ROOT_SCOPE_ID,
	forScopeKey,
	tryScopeKey,
	catchScopeKey,
	forkBranchScopeKey,
	isWorkflowScopeKey,
	workflowEndNodeId,
	workflowScopeKey,
	workflowStartNodeId
} from './scopeKey';
import { switchCasesOf } from './switchCases';

export interface ScopeGraph {
	nodes: Node[];
	edges: Edge[];
}

export interface WorkflowGraph {
	scopes: Record<string, ScopeGraph>;
}

export interface WorkflowHeaderFields {
	workflowType: string;
	taskQueue: string;
	version: string;
	title?: string;
	summary?: string;
	tags?: Record<string, string>;
	metadata?: Record<string, unknown>;
	inputSchema?: InputField[];
	/**
	 * Lives in two places in the document (`schedule:` plus a few `document.metadata` keys), so it
	 * travels as one UI-level object and `schedule.ts` owns the split — never patch those keys
	 * through `metadata` directly.
	 */
	schedule?: WorkflowSchedule;
}

function definedEntries<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined && v !== '') (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function entriesFromRecord(rec: Record<string, unknown> | undefined): VarEntry[] {
	if (!rec) return [];
	return Object.entries(rec).map(([key, value]) => ({
		key,
		value: typeof value === 'string' ? value : JSON.stringify(value)
	}));
}

function recordFromEntries(entries: VarEntry[] | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const e of entries ?? []) if (e.key) out[e.key] = e.value;
	return out;
}

interface JsonSchemaProperty {
	type?: string;
	description?: string;
	items?: { type?: string };
}

/** Best-effort JSON parse for opaque round-tripped fields (task `metadata`, `input`/`output`/`export`
 * `.schema`, container `volumes`) — invalid/empty text is treated as "not set" rather than thrown. */
function parseJsonField(raw: string | undefined): Record<string, unknown> | undefined {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function stringifyJsonField(value: unknown): string {
	return value !== undefined ? JSON.stringify(value) : '';
}

/** `run.{container,shell,script}` `arguments` — a UI-friendly one-per-line string, stored as an array in the DSL. */
function argsFromText(raw: string | undefined): string[] {
	return (raw ?? '')
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Inverse of `stringifyInputSchema` — the document-level `input.schema` -> the Start node's flat field-list UI model. */
export function parseInputSchema(input: InputConfig | undefined): InputField[] {
	const doc = input?.schema?.document as
		{ properties?: Record<string, JsonSchemaProperty>; required?: string[] } | undefined;
	if (!doc?.properties) return [];
	const required = new Set(doc.required ?? []);
	return Object.entries(doc.properties).map(([name, prop]) => ({
		name,
		type: (prop.type as InputField['type']) ?? 'string',
		required: required.has(name) || undefined,
		...(prop.type === 'array'
			? { itemsType: (prop.items?.type as InputField['itemsType']) ?? 'string' }
			: {}),
		...(prop.description ? { description: prop.description } : {})
	}));
}

/** The Start node's flat field-list UI model -> a real JSON Schema for the document-level `input.schema`. */
function stringifyInputSchema(fields: InputField[]): InputConfig | undefined {
	const named = fields.filter((f) => f.name);
	if (named.length === 0) return undefined;

	const properties: Record<string, JsonSchemaProperty> = {};
	const required: string[] = [];
	for (const f of named) {
		properties[f.name] = {
			type: f.type,
			...(f.description ? { description: f.description } : {}),
			...(f.type === 'array' ? { items: { type: f.itemsType ?? 'string' } } : {})
		};
		if (f.required) required.push(f.name);
	}

	return {
		schema: {
			format: 'json',
			document: { type: 'object', ...(required.length > 0 ? { required } : {}), properties }
		}
	};
}

// =========================================================================
// graphToAst — node-graph (per scope) -> ZigflowDocument
// =========================================================================

export function graphToAst(graph: WorkflowGraph, header: WorkflowHeaderFields): ZigflowDocument {
	const workflowType = header.workflowType || 'workflow';
	const scheduleParts = applyWorkflowSchedule(header.schedule, header.metadata, workflowType);
	const documentHeader: ZigflowDocumentHeader = {
		dsl: '1.0.0',
		taskQueue: header.taskQueue || 'zigflow',
		workflowType,
		version: header.version || '0.1.0',
		...(header.title ? { title: header.title } : {}),
		...(header.summary ? { summary: header.summary } : {}),
		...(header.tags && Object.keys(header.tags).length > 0 ? { tags: header.tags } : {}),
		...(scheduleParts.metadata ? { metadata: scheduleParts.metadata } : {})
	};
	const input = stringifyInputSchema(header.inputSchema ?? []);
	const ctx: EmitContext = { graph, workflowNames: namedWorkflowNames(graph) };
	return {
		document: documentHeader,
		...(input ? { input } : {}),
		...(scheduleParts.schedule ? { schedule: scheduleParts.schedule } : {}),
		do: scopeToTaskList(ctx, ROOT_SCOPE_ID)
	};
}

interface EmitContext {
	graph: WorkflowGraph;
	/** Start node id -> the task key each named workflow is saved (and registered) under. */
	workflowNames: Map<string, string>;
}

// =========================================================================
// Named workflows
// =========================================================================

/**
 * The primary workflow's start/end node ids — fixed, and never deletable. (A named workflow's
 * Start is deletable, and takes the whole workflow with it; its End never is on its own.)
 */
export const PRIMARY_START_ID = 'start';
export const PRIMARY_END_ID = 'end';

/**
 * True for the Start of a named workflow (as opposed to the primary workflow's Start). Both are
 * plain `start` nodes: a named workflow is drawn exactly like the primary one, and differs only in
 * carrying a name — the task key the DSL saves it under and the Temporal workflow type zigflow
 * registers it as.
 */
export function isNamedWorkflowStart(node: Node | undefined): boolean {
	return node?.type === 'start' && node.id !== PRIMARY_START_ID;
}

/** Every named workflow's scope key, in the order they were declared/added. */
export function namedWorkflowScopes(graph: WorkflowGraph): string[] {
	return Object.keys(graph.scopes).filter(isWorkflowScopeKey);
}

/** A named workflow's Start node, looked up from its scope. */
export function namedWorkflowStart(graph: WorkflowGraph, scopeKey: string): Node | undefined {
	const id = workflowStartNodeId(scopeKey);
	return graph.scopes[scopeKey]?.nodes.find((n) => n.id === id);
}

/**
 * The name every named workflow is saved under, by Start node id. Allocated once for the whole
 * document rather than per task list, because zigflow registers them in one namespace: two with
 * the same name would collide at worker start, and a switch case anywhere names one by it.
 */
export function namedWorkflowNames(graph: WorkflowGraph): Map<string, string> {
	const used = new Set<string>();
	const names = new Map<string, string>();
	for (const key of namedWorkflowScopes(graph)) {
		const start = namedWorkflowStart(graph, key);
		if (!start) continue;
		names.set(start.id, uniqueTaskName((start.data?.label as string) || 'workflow', used));
	}
	return names;
}

/**
 * A brand-new named workflow's scope: its own Start (holding the name and the parameters it
 * starts with) wired straight to its own End, exactly like the primary workflow before anything
 * has been added to it.
 */
export function newNamedWorkflowScope(
	name: string,
	variables: VarEntry[] = [],
	declaredIn: string = ROOT_SCOPE_ID
): { key: string; scope: ScopeGraph } {
	const startId = newNodeId();
	const key = workflowScopeKey(startId);
	const endId = workflowEndNodeId(startId);
	const nodes: Node[] = [
		{
			id: startId,
			type: 'start',
			position: { x: 0, y: 0 },
			data: { type: 'start', label: name, variables, declaredIn }
		},
		{
			id: endId,
			type: 'end',
			position: { x: 0, y: 0 },
			data: { type: 'end', label: 'End' },
			deletable: false
		}
	];
	return {
		key,
		scope: { nodes, edges: [{ id: `e-${startId}-${endId}`, source: startId, target: endId }] }
	};
}

/**
 * The named workflows a task list declares. Each Start remembers the scope its `do:` was written
 * in (`declaredIn`) so a document round-trips in the shape it was authored; one whose declaring
 * scope is gone — or could no longer hold it — is written at the top level instead.
 */
function namedWorkflowsDeclaredIn(ctx: EmitContext, scopeId: string): Node[] {
	const out: Node[] = [];
	for (const key of namedWorkflowScopes(ctx.graph)) {
		const start = namedWorkflowStart(ctx.graph, key);
		if (!start) continue;
		const declaredIn = start.data?.declaredIn as string | undefined;
		const home =
			declaredIn && canDeclareWorkflows(ctx.graph, declaredIn) ? declaredIn : ROOT_SCOPE_ID;
		if (home === scopeId) out.push(start);
	}
	return out;
}

/**
 * Whether a task list can declare a named workflow. Zigflow only treats a `do:` task as a
 * workflow of its own when a non-`do:` task comes before it in the same list — otherwise it runs
 * it in place, as a plain group — so a nested list with no such task falls back to the top level.
 * (The top level always qualifies: with no other task there, every `do:` is a workflow anyway.)
 */
function canDeclareWorkflows(graph: WorkflowGraph, scopeId: string): boolean {
	if (scopeId === ROOT_SCOPE_ID) return true;
	const scope = graph.scopes[scopeId];
	if (!scope) return false;
	return scope.nodes.some((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'do');
}

/**
 * The DSL task name of every step in one task list, by node id — shared by `scopeToTaskList` and
 * `runIndex.ts`, which must agree exactly on what each task was called. The names of named
 * workflows declared in the same list are reserved first: a workflow's name is fixed document
 * wide, so a sibling task is the one that gives way.
 */
export function taskNamesInScope(
	graph: WorkflowGraph,
	scopeId: string,
	workflowNames: Map<string, string> = namedWorkflowNames(graph)
): { chain: Node[]; names: Map<string, string>; declared: Node[] } {
	const scope = graph.scopes[scopeId];
	const chain = scope
		? orderNodesInScope(scope.nodes, scope.edges).filter(
				(n) => n.type !== 'start' && n.type !== 'end'
			)
		: [];
	const declared = namedWorkflowsDeclaredIn({ graph, workflowNames }, scopeId);
	const used = new Set<string>(declared.map((s) => workflowNames.get(s.id)!));
	const names = new Map<string, string>();
	for (const node of chain) {
		names.set(node.id, uniqueTaskName((node.data?.label as string) ?? node.type ?? 'task', used));
	}
	return { chain, names, declared };
}

function scopeToTaskList(ctx: EmitContext, scopeId: string): TaskList {
	const scope = ctx.graph.scopes[scopeId];
	if (!scope) return [];

	const {
		chain,
		names: idToName,
		declared
	} = taskNamesInScope(ctx.graph, scopeId, ctx.workflowNames);

	const list: TaskList = [];

	// A Start's parameters (the primary workflow's, or a named workflow's) become a synthetic
	// leading `init` set task — there is no real "start" task in the DSL.
	list.push(...initTaskFor(scope.nodes.find((n) => n.type === 'start')));

	for (const node of chain) {
		const name = idToName.get(node.id)!;

		// A switch is the one node whose task can't be built from the node alone: its cases name
		// other tasks, which only the emit context knows the allocated names of.
		if (node.type === 'switch') {
			list.push({
				[name]: {
					...taskBaseFromData((node.data ?? {}) as Record<string, unknown>),
					switch: switchCasesToAst(node, ctx, idToName)
				}
			});
			continue;
		}

		list.push({ [name]: nodeToTask(node, ctx, scopeId) });
	}

	// Declared after the chain: zigflow only registers a `do:` as its own workflow once a non-`do:`
	// task precedes it, and where in the list it sits changes nothing else.
	for (const start of declared) {
		list.push({ [ctx.workflowNames.get(start.id)!]: workflowTask(start, ctx) });
	}

	return list;
}

/** The task name a Start's parameters are saved under, and read back from. */
const INIT_TASK_NAME = 'init';

/**
 * The leading `init: set: {...}` a Start node's parameters become, or nothing when it has none.
 * Shared by the primary workflow's Start node and every named workflow's: it seeds `$data` for
 * that workflow's own run.
 */
function initTaskFor(startNode: Node | undefined): TaskList {
	const vars = ((startNode?.data?.variables as VarEntry[]) ?? []).filter((v) => v.key);
	return vars.length > 0 ? [{ [INIT_TASK_NAME]: { set: recordFromEntries(vars) } }] : [];
}

/**
 * Inverse of `initTaskFor`: a list's leading `init` task that is nothing but a `set:` is a Start's
 * parameters, so it is lifted back onto the Start instead of loading as a step of its own.
 */
function splitInitTask(list: TaskList): { variables: VarEntry[]; rest: TaskList } {
	const first = list[0];
	if (!first) return { variables: [], rest: list };
	const [name, task] = Object.entries(first)[0];
	const keys = Object.keys(task);
	if (name !== INIT_TASK_NAME || keys.length !== 1 || keys[0] !== 'set') {
		return { variables: [], rest: list };
	}
	return {
		variables: entriesFromRecord((task as { set: Record<string, unknown> }).set),
		rest: list.slice(1)
	};
}

/** A named workflow: `<name>: { do: [...] }`, built from its Start node and its own scope. */
function workflowTask(start: Node, ctx: EmitContext): TaskNode {
	const data = (start.data ?? {}) as Record<string, unknown>;
	return {
		...taskBaseFromData(data),
		do: scopeToTaskList(ctx, workflowScopeKey(start.id))
	} as TaskNode;
}

/**
 * Where one case sends the run, as the `then:` the DSL wants: a flow directive as written, or the
 * name of a named workflow — zigflow starts a switch's named `then:` as a child workflow, whichever
 * list declares it. The target is re-resolved through its Start node so a rename keeps the jump,
 * falling back to the name the document had.
 */
function caseTargetToAst(
	c: CaseEntry,
	ctx: EmitContext,
	idToName: Map<string, string>
): FlowDirective {
	if (c.routing !== 'task') return c.routing;
	if (c.targetNodeId) {
		const workflow = ctx.workflowNames.get(c.targetNodeId);
		if (workflow) return workflow;
		// Only reachable from hand-written DSL whose `then:` names a sibling task.
		const sibling = idToName.get(c.targetNodeId);
		if (sibling) return sibling;
		return 'continue';
	}
	// A `targetNodeId` that no longer resolves (above) means what it named has been deleted — a
	// dangling `then:` is DSL no worker can run, so the case carries on instead. A case that never
	// resolved keeps the name the document had, so hand-written DSL round-trips unchanged.
	return c.taskName ?? 'continue';
}

function switchCasesToAst(
	node: Node,
	ctx: EmitContext,
	idToName: Map<string, string>
): SwitchCase[] {
	return switchCasesOf(node).map((c) => {
		const when = c.condition?.trim();
		const body: SwitchCaseBody = { then: caseTargetToAst(c, ctx, idToName) };
		if (when) body.when = when;
		return { [toTaskName(c.name) || 'case']: body };
	});
}

function nodeToTask(node: Node, ctx: EmitContext, scopeId: string): TaskNode {
	const data = (node.data ?? {}) as Record<string, unknown>;
	const type = (node.type ?? 'set') as WorkflowNodeType;
	const base = taskBaseFromData(data);

	switch (type) {
		case 'call':
			return { ...base, call: 'http', with: httpWithFromData(data) };
		case 'grpcCall':
			return { ...base, call: 'grpc', with: grpcWithFromData(data) };
		case 'set':
			return { ...base, set: setMapFromData(data) };
		case 'wait':
			return { ...base, wait: waitFromData(data) };
		case 'listen':
			return { ...base, listen: { to: strategyFromData(data) } };
		case 'raise':
			return { ...base, raise: raiseFromData(data) };
		case 'run': {
			// `run.workflow` tasks are exclusively authored via the dedicated `childWorkflow` node
			// (below) — `taskKindToNodeType` always loads any `run.workflow` task back as that node
			// type, never as `run`, so a `runType === 'workflow'` branch here was a dead end that could
			// never round-trip back to itself. See `case 'childWorkflow'`.
			const runType = (data.runType as string) ?? 'script';
			return {
				...base,
				run: runConfigFromData(runType, data),
				...(data.await === false ? { await: false } : {})
			};
		}
		case 'childWorkflow': {
			const childInput = ((data.childInput as string) ?? '').trim();
			// `run.workflow.input` must be a JSON object per schema (unlike output/export `.as`,
			// it has no runtime-expression string variant) — wrap a customized expression under a
			// `value` key so the emitted DSL stays schema-valid; omit entirely when left at default.
			const input = childInput && childInput !== '${ . }' ? { value: childInput } : undefined;
			return {
				...base,
				run: {
					workflow: definedEntries({
						type: (data.workflowType as string) || 'child-workflow-type',
						input
					}) as never
				},
				...(data.await === false ? { await: false } : {})
			};
		}
		case 'for': {
			const childScope = forScopeKey(scopeId, node.id);
			const forTask: ForTask = {
				...base,
				for: definedEntries({
					each: (data.each as string) || 'item',
					at: (data.at as string) || 'index',
					in: (data.in as string) || '${ $input.items }'
				}) as ForTask['for'],
				do: scopeToTaskList(ctx, childScope)
			};
			const whileExpr = ((data.while as string) ?? '').trim();
			if (whileExpr) forTask.while = whileExpr;
			return forTask;
		}
		case 'fork': {
			const branches = (data.branches as BranchEntry[]) ?? [];
			const branchList: TaskList = branches.map((b) => {
				const childScope = forkBranchScopeKey(scopeId, node.id, b.id);
				const branchName = toSlug(b.name) || 'branch';
				const body = scopeToTaskList(ctx, childScope);
				// A branch scope holding exactly one task named identically to the branch itself is how
				// a bare (non-`do`-wrapped) branch task round-trips — e.g. a branch that's just a `for`
				// or `run` task, not a `do:` grouping. Emitting it bare here mirrors the load-side
				// detection in `dataFromTask`'s fork case below; anything else falls back to the
				// conventional `{ do: [...] }` wrapper.
				if (body.length === 1) {
					const [taskName, task] = Object.entries(body[0])[0];
					if (taskName === branchName) return { [branchName]: task };
				}
				return { [branchName]: { do: body } };
			});
			const forkTask: ForkTask = {
				...base,
				fork: { branches: branchList, ...(data.compete === true ? { compete: true } : {}) }
			};
			return forkTask;
		}
		case 'try': {
			const tryScope = tryScopeKey(scopeId, node.id);
			const catchScope = catchScopeKey(scopeId, node.id);
			const tryTask: TryTask = {
				...base,
				try: scopeToTaskList(ctx, tryScope),
				catch: { as: (data.catchAs as string) || 'error', do: scopeToTaskList(ctx, catchScope) }
			};
			return tryTask;
		}
		case 'do': {
			const childScope = forScopeKey(scopeId, node.id);
			return { ...base, do: scopeToTaskList(ctx, childScope) };
		}
		// `switch` never reaches here: `scopeToTaskList` builds it itself, because its branch cases
		// need the sibling names that function is in the middle of allocating.
		default:
			throw new Error(`Cannot convert node type "${type}" (${node.id}) to a Zigflow task`);
	}
}

/**
 * `output.as` / `export.as` may be a plain jq expression string OR a literal/templated object
 * (e.g. `{ data: ${ . } }`) per schema. The UI's `outputAs`/`exportAs` fields are single strings,
 * so an object form is round-tripped as its JSON text (rather than silently dropped) — editing it
 * back to a bare expression works the same as before.
 */
function parseAsField(raw: string): string | Record<string, unknown> | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			// Not valid JSON — fall through and treat it as a literal expression string.
		}
	}
	return trimmed;
}

function taskBaseFromData(data: Record<string, unknown>): Record<string, unknown> {
	const ifExpr = ((data.if as string) ?? '').trim();
	const outputAs = parseAsField((data.outputAs as string) ?? '');
	const exportAs = parseAsField((data.exportAs as string) ?? '');
	// `metadata`/`input.schema`/`output.schema`/`export.schema` have no dedicated editor UI yet —
	// round-tripped opaquely (via *ToData below) so hand-authored DSL loaded then re-saved from the
	// canvas doesn't silently lose them.
	const metadata = parseJsonField(data.metadataJson as string);
	const inputSchema = parseJsonField(data.inputSchemaJson as string);
	const outputSchema = parseJsonField(data.outputSchemaJson as string);
	const exportSchema = parseJsonField(data.exportSchemaJson as string);
	const output = {
		...(outputAs !== undefined ? { as: outputAs } : {}),
		...(outputSchema ? { schema: outputSchema } : {})
	};
	const exportCfg = {
		...(exportAs !== undefined ? { as: exportAs } : {}),
		...(exportSchema ? { schema: exportSchema } : {})
	};
	return {
		...(ifExpr ? { if: ifExpr } : {}),
		...(inputSchema ? { input: { schema: inputSchema } } : {}),
		...(Object.keys(output).length > 0 ? { output } : {}),
		...(Object.keys(exportCfg).length > 0 ? { export: exportCfg } : {}),
		...(metadata ? { metadata } : {})
	};
}

function httpWithFromData(data: Record<string, unknown>) {
	const headers = recordFromEntries(((data.headers as VarEntry[]) ?? []).filter((h) => h.key));
	const query = recordFromEntries(((data.query as VarEntry[]) ?? []).filter((q) => q.key));
	return {
		method: (data.method as string) || 'get',
		endpoint: (data.endpoint as string) || '',
		...(Object.keys(headers).length > 0 ? { headers: headers as Record<string, string> } : {}),
		...(Object.keys(query).length > 0 ? { query: query as Record<string, string> } : {}),
		...(data.body ? { body: data.body } : {}),
		...(data.output && data.output !== 'content'
			? { output: data.output as 'raw' | 'response' }
			: {}),
		...(data.redirect === true ? { redirect: true } : {})
	};
}

function grpcWithFromData(data: Record<string, unknown>) {
	const args = parseJsonField(data.argumentsJson as string);
	const port = data.servicePort;
	return {
		proto: { endpoint: (data.protoEndpoint as string) || '' },
		service: {
			host: (data.serviceHost as string) || '',
			name: (data.serviceName as string) || '',
			...(typeof port === 'number' ? { port } : {})
		},
		method: (data.method as string) || '',
		...(args ? { arguments: args } : {})
	};
}

function setMapFromData(data: Record<string, unknown>): Record<string, unknown> {
	const vars = ((data.variables as VarEntry[]) ?? []).filter((v) => v.key);
	return vars.length > 0 ? recordFromEntries(vars) : { result: '${ . }' };
}

function waitFromData(data: Record<string, unknown>) {
	if ((data.waitMode as string) === 'until') {
		return { until: (data.until as string) || '' };
	}
	// Zero components are dropped: the duration editor always holds all four fields, so keeping
	// them would turn a hand-written `wait: { seconds: 2 }` into a four-line block of mostly zeroes
	// the first time its workflow was re-saved.
	const d = definedEntries({
		days: (data.days as number) || undefined,
		hours: (data.hours as number) || undefined,
		minutes: (data.minutes as number) || undefined,
		seconds: (data.seconds as number) || undefined
	});
	return Object.keys(d).length > 0 ? d : { seconds: 30 };
}

function strategyFromData(data: Record<string, unknown>): EventConsumptionStrategy {
	const strategy = (data.strategy as string) || 'one';
	const events = (data.events as EventEntry[]) ?? [];
	const filters: EventFilter[] = events.map((e) => ({
		with: definedEntries({
			id: e.id,
			type: e.type,
			data: e.data,
			acceptIf: e.acceptIf
		}) as EventFilter['with']
	}));
	if (strategy === 'one')
		return { one: filters[0] ?? { with: { id: 'my-event', type: 'signal' } } };
	if (strategy === 'all') return { all: filters };
	return { any: filters };
}

function raiseFromData(data: Record<string, unknown>) {
	return {
		error: definedEntries({
			type:
				(data.errorType as string) ||
				'https://serverlessworkflow.io/spec/1.0.0/errors/communication',
			status: (data.errorStatus as number) ?? 500,
			instance: data.errorInstance as string,
			title: data.errorTitle as string,
			detail: data.errorDetail as string
		}) as { type: string; status: number }
	};
}

function runConfigFromData(runType: string, data: Record<string, unknown>): RunConfig {
	const environment = recordFromEntries(
		((data.environment as VarEntry[]) ?? []).filter((e) => e.key)
	) as Record<string, string>;
	const argumentsList = argsFromText(data.arguments as string);
	const envEntry = Object.keys(environment).length > 0 ? { environment } : {};
	const argsEntry = argumentsList.length > 0 ? { arguments: argumentsList } : {};

	if (runType === 'container') {
		const volumes = parseJsonField(data.volumesJson as string);
		const cleanup = ((data.lifetimeCleanup as string) ?? '').trim();
		const command = ((data.command as string) ?? '').trim();
		const name = ((data.containerName as string) ?? '').trim();
		return {
			container: {
				image: (data.image as string) || 'alpine:latest',
				pullPolicy: ((data.pullPolicy as PullPolicy) || 'ifNotPresent') as PullPolicy,
				...(name ? { name } : {}),
				...(command ? { command } : {}),
				...(volumes ? { volumes } : {}),
				...envEntry,
				...argsEntry,
				...(cleanup ? { lifetime: { cleanup: cleanup as 'always' | 'never' } } : {})
			}
		};
	}
	if (runType === 'shell') {
		return {
			shell: {
				command: (data.command as string) || 'echo hello',
				...envEntry,
				...argsEntry
			}
		};
	}
	const sourceEndpoint = ((data.sourceEndpoint as string) ?? '').trim();
	return {
		script: {
			language: ((data.language as 'js' | 'python') || 'js') as 'js' | 'python',
			...(sourceEndpoint
				? { source: { endpoint: sourceEndpoint } }
				: { code: (data.code as string) ?? '' }),
			...envEntry,
			...argsEntry
		}
	};
}

// =========================================================================
// astToGraph — ZigflowDocument -> node-graph (per scope)
// =========================================================================

export function astToGraph(doc: ZigflowDocument): {
	graph: WorkflowGraph;
	header: WorkflowHeaderFields;
} {
	const scopes: Record<string, ScopeGraph> = {};
	const { variables, rest } = splitInitTask(doc.do);
	buildScope(rest, ROOT_SCOPE_ID, scopes, {
		start: {
			id: PRIMARY_START_ID,
			type: 'start',
			position: { x: 0, y: 0 },
			data: { type: 'start', label: 'Start', variables },
			deletable: false
		},
		end: {
			id: PRIMARY_END_ID,
			type: 'end',
			position: { x: 0, y: 0 },
			data: { type: 'end', label: 'End' },
			deletable: false
		}
	});
	resolveCaseTargets({ scopes });
	return {
		graph: { scopes },
		header: {
			workflowType: doc.document.workflowType,
			taskQueue: doc.document.taskQueue,
			version: doc.document.version,
			title: doc.document.title,
			summary: doc.document.summary,
			tags: doc.document.tags,
			metadata: doc.document.metadata,
			inputSchema: parseInputSchema(doc.input),
			schedule: readWorkflowSchedule(doc)
		}
	};
}

function newNodeId(): string {
	return `node-${crypto.randomUUID()}`;
}

/** The Start and End a top-level flow (the primary workflow, or a named one) is drawn between. */
interface FlowTerminals {
	start: Node;
	end: Node;
}

/**
 * Which entries of a task list are named workflows rather than steps, mirroring zigflow's own
 * rule (`DoTaskBuilder.Build`): a `do:` task that follows any non-`do:` task in the same list is
 * registered as a Temporal workflow of its own and skipped in place. At the top level of a
 * document holding nothing but `do:` tasks, every one of them is a workflow.
 */
function namedWorkflowEntries(list: TaskList, scopeId: string): boolean[] {
	const isDo = list.map((entry) => isBareDoWrapper(Object.values(entry)[0]));
	const allDo = isDo.length > 0 && isDo.every(Boolean);
	let seenStep = false;
	return isDo.map((d) => {
		const named = d && (seenStep || (allDo && scopeId === ROOT_SCOPE_ID));
		if (!d) seenStep = true;
		return named;
	});
}

function buildScope(
	list: TaskList,
	scopeId: string,
	scopesOut: Record<string, ScopeGraph>,
	terminals?: FlowTerminals
): void {
	const nodes: Node[] = [];
	const named = namedWorkflowEntries(list, scopeId);
	const steps: { name: string; task: TaskNode }[] = [];

	list.forEach((entry, i) => {
		const [name, task] = Object.entries(entry)[0];
		// A named workflow is not a step of this list: it is drawn as a flow of its own, remembering
		// only that this is the list that declares it.
		if (named[i]) buildNamedWorkflow(name, task as TaskNode & { do: TaskList }, scopeId, scopesOut);
		else steps.push({ name, task });
	});

	// Pass 1: allocate a node id + type per task so nested-scope keys are available while building
	// task bodies in pass 2.
	for (const { name, task } of steps) {
		nodes.push({
			id: newNodeId(),
			type: taskKindToNodeType(task),
			position: { x: 0, y: 0 },
			data: { label: name }
		});
	}

	// Pass 2: fill each node's data, recursing into nested scopes as needed.
	nodes.forEach((node, idx) => {
		node.data = {
			type: node.type,
			...node.data,
			...dataFromTask(steps[idx].task, node.id, scopeId, scopesOut)
		};
	});

	const chain = terminals ? [terminals.start, ...nodes, terminals.end] : nodes;
	const edges: Edge[] = [];
	for (let i = 0; i < chain.length - 1; i++) {
		edges.push({
			id: `e-${chain[i].id}-${chain[i + 1].id}`,
			source: chain[i].id,
			target: chain[i + 1].id
		});
	}

	layoutScope(chain, edges);
	scopesOut[scopeId] = { nodes: chain, edges };
}

/**
 * A named workflow loads exactly like the primary one: its own Start (named after the task key,
 * holding its leading `init: set:` as parameters), its steps, and its own End — in a scope of its
 * own, since it runs as a separate Temporal workflow rather than as part of the list declaring it.
 */
function buildNamedWorkflow(
	name: string,
	task: TaskNode & { do: TaskList },
	declaredIn: string,
	scopesOut: Record<string, ScopeGraph>
): void {
	const { variables, rest } = splitInitTask(task.do);
	const { key, scope } = newNamedWorkflowScope(name, variables, declaredIn);
	const [start, end] = scope.nodes;
	start.data = { ...start.data, ...taskBaseToData(task) };
	// Registered before the body is built so declaration order is kept: the first `do:` in the
	// document is the first named workflow on the canvas.
	scopesOut[key] = scope;
	buildScope(rest, key, scopesOut, { start, end });
}

/**
 * Resolves every loaded switch case's `then:` to the node it names, now that the whole document —
 * including named workflows declared further down or deeper in — has been built. A name is looked
 * up among named workflows first, since that is what zigflow starts for a named `then:`; a sibling
 * task of the same name is the fallback for hand-written DSL that means one.
 */
function resolveCaseTargets(graph: WorkflowGraph): void {
	const workflowIds = new Map<string, string>();
	for (const key of namedWorkflowScopes(graph)) {
		const start = namedWorkflowStart(graph, key);
		if (start) workflowIds.set(start.data?.label as string, start.id);
	}

	for (const scope of Object.values(graph.scopes)) {
		const siblingIds = new Map(scope.nodes.map((n) => [n.data?.label as string, n.id]));
		for (const node of scope.nodes) {
			if (node.type !== 'switch') continue;
			const cases = switchCasesOf(node).map((c) => {
				if (c.routing !== 'task' || !c.taskName) return c;
				const targetNodeId = workflowIds.get(c.taskName) ?? siblingIds.get(c.taskName);
				return targetNodeId ? { ...c, targetNodeId } : c;
			});
			node.data = { ...node.data, cases };
		}
	}
}

/** One case of a loaded `switch`, resolved to how the canvas should model it. */
interface SwitchCasePlan {
	caseName: string;
	when?: string;
	routing: CaseRouting;
	/** `task` routings only — the name the document's `then:` jumped at. */
	taskName?: string;
}

/**
 * What each of a `switch`'s cases becomes on the canvas. There is nothing to restructure: a case's
 * `then:` is either one of the three flow directives or the name of a workflow to start, and both
 * are kept exactly as written. The name is resolved to a node once the whole document is loaded
 * (`resolveCaseTargets`), so a jump survives its target being renamed; an unresolvable name stays
 * as `taskName` so the document round-trips unchanged rather than losing the jump.
 */
function planSwitchCases(task: SwitchTask): SwitchCasePlan[] {
	return task.switch.map((item) => {
		const [caseName, body] = Object.entries(item)[0];
		const then = body.then;
		if (then === 'continue' || then === 'exit' || then === 'end') {
			// `FlowDirective` is the three directives *or* any task name, so the cast is what narrows
			// the matched literal back down for `CaseRouting`.
			return { caseName, when: body.when, routing: then as CaseRouting };
		}
		return { caseName, when: body.when, routing: 'task' as CaseRouting, taskName: then };
	});
}

/**
 * Which node a loaded step becomes. A `do:` that reaches here is one zigflow runs in place (a
 * plain group); the ones it runs as workflows of their own never become a node at all — see
 * `namedWorkflowEntries`.
 */
function taskKindToNodeType(task: TaskNode): WorkflowNodeType {
	if ('call' in task) return task.call === 'grpc' ? 'grpcCall' : 'call';
	if ('for' in task) return 'for';
	if ('fork' in task) return 'fork';
	if ('listen' in task) return 'listen';
	if ('raise' in task) return 'raise';
	if ('run' in task) return 'workflow' in task.run ? 'childWorkflow' : 'run';
	if ('set' in task) return 'set';
	if ('switch' in task) return 'switch';
	if ('try' in task) return 'try';
	if ('wait' in task) return 'wait';
	if ('do' in task) return 'do';
	throw new Error('Unknown task shape while converting DSL to the canvas');
}

function dataFromTask(
	task: TaskNode,
	nodeId: string,
	scopeId: string,
	scopesOut: Record<string, ScopeGraph>
): Record<string, unknown> {
	const base = taskBaseToData(task);

	if ('call' in task && task.call === 'grpc') {
		const w = task.with;
		return {
			...base,
			protoEndpoint: w.proto.endpoint,
			serviceHost: w.service.host,
			serviceName: w.service.name,
			servicePort: w.service.port,
			method: w.method,
			argumentsJson: stringifyJsonField(w.arguments)
		};
	}
	if ('call' in task) {
		const w = task.with;
		return {
			...base,
			method: w.method,
			endpoint: w.endpoint,
			headers: entriesFromRecord(w.headers),
			query: entriesFromRecord(w.query),
			body:
				typeof w.body === 'string' ? w.body : w.body !== undefined ? JSON.stringify(w.body) : '',
			output: w.output ?? 'content',
			redirect: w.redirect === true
		};
	}
	if ('for' in task) {
		buildScope(task.do, forScopeKey(scopeId, nodeId), scopesOut);
		return {
			...base,
			each: task.for.each ?? 'item',
			at: task.for.at ?? 'index',
			in: task.for.in,
			while: task.while ?? ''
		};
	}
	if ('fork' in task) {
		const branches: BranchEntry[] = task.fork.branches.map((entry) => {
			const [branchName, branchTask] = Object.entries(entry)[0];
			const id = crypto.randomUUID();
			// Only the `{ do: [...] }` grouping convention unwraps — see `isBareDoWrapper`.
			const branchList = isBareDoWrapper(branchTask)
				? branchTask.do
				: [{ [branchName]: branchTask }];
			buildScope(branchList, forkBranchScopeKey(scopeId, nodeId, id), scopesOut);
			return { id, name: branchName };
		});
		return { ...base, compete: task.fork.compete === true, branches };
	}
	if ('listen' in task) {
		const { strategy, events } = eventEntriesFromStrategy(task.listen.to);
		return { ...base, strategy, events };
	}
	if ('raise' in task) return { ...base, ...raiseDataFromTask(task) };
	if ('run' in task) {
		if ('workflow' in task.run) return { ...base, ...childWorkflowDataFromTask(task) };
		return { ...base, ...runDataFromTask(task) };
	}
	if ('set' in task) return { ...base, variables: entriesFromRecord(task.set) };
	if ('switch' in task) {
		// Targets are resolved once the whole document is built — see `resolveCaseTargets`.
		const cases: CaseEntry[] = planSwitchCases(task).map((p) => ({
			id: crypto.randomUUID(),
			name: p.caseName,
			condition: p.when ?? '',
			routing: p.routing,
			...(p.taskName ? { taskName: p.taskName } : {})
		}));
		return { ...base, cases };
	}
	if ('try' in task) {
		buildScope(task.try, tryScopeKey(scopeId, nodeId), scopesOut);
		buildScope(task.catch.do, catchScopeKey(scopeId, nodeId), scopesOut);
		return { ...base, catchAs: task.catch.as ?? 'error' };
	}
	if ('wait' in task) return { ...base, ...waitDataFromTask(task) };
	if ('do' in task) {
		// A group zigflow runs in place — named workflows never reach here (`namedWorkflowEntries`).
		buildScope(task.do, forScopeKey(scopeId, nodeId), scopesOut);
		return base;
	}
	return base;
}

const TASK_DISCRIMINATOR_KEYS = [
	'call',
	'for',
	'fork',
	'listen',
	'raise',
	'run',
	'set',
	'switch',
	'try',
	'wait'
] as const;

/** True only for `{ do: taskList }` — a `for` task also has a `do` key (its body), so a real
 * discriminator key present alongside `do` means this is a bare typed task, not the `do:` grouping
 * convention used to author a fork/branch body directly as a list. */
function isBareDoWrapper(task: TaskNode): task is TaskNode & { do: TaskList } {
	return 'do' in task && !TASK_DISCRIMINATOR_KEYS.some((k) => k in task);
}

/** Inverse of `parseAsField` — object-form `.as` becomes its JSON text so it isn't dropped. */
function stringifyAsField(as: string | Record<string, unknown> | undefined): string {
	if (as === undefined) return '';
	return typeof as === 'string' ? as : JSON.stringify(as);
}

function taskBaseToData(task: TaskNode): Record<string, unknown> {
	return {
		if: task.if ?? '',
		outputAs: stringifyAsField(task.output?.as),
		exportAs: stringifyAsField(task.export?.as),
		metadataJson: stringifyJsonField(task.metadata),
		inputSchemaJson: stringifyJsonField(task.input?.schema),
		outputSchemaJson: stringifyJsonField(task.output?.schema),
		exportSchemaJson: stringifyJsonField(task.export?.schema)
	};
}

function waitDataFromTask(task: WaitTask): Record<string, unknown> {
	const w = task.wait;
	if ('until' in w) return { waitMode: 'until', until: w.until };
	return {
		waitMode: 'duration',
		days: (w.days as number) ?? 0,
		hours: (w.hours as number) ?? 0,
		minutes: (w.minutes as number) ?? 0,
		seconds: (w.seconds as number) ?? 30
	};
}

function eventEntryFromFilter(f: EventFilter): EventEntry {
	return {
		id: f.with.id ?? '',
		type: (f.with.type as EventEntry['type']) ?? 'signal',
		data:
			f.with.data !== undefined
				? typeof f.with.data === 'string'
					? f.with.data
					: JSON.stringify(f.with.data)
				: undefined,
		acceptIf: f.with.acceptIf
	};
}

function eventEntriesFromStrategy(to: EventConsumptionStrategy): {
	strategy: 'all' | 'any' | 'one';
	events: EventEntry[];
} {
	if ('one' in to) return { strategy: 'one', events: [eventEntryFromFilter(to.one)] };
	if ('any' in to) return { strategy: 'any', events: to.any.map(eventEntryFromFilter) };
	return { strategy: 'all', events: to.all.map(eventEntryFromFilter) };
}

function raiseDataFromTask(task: RaiseTask): Record<string, unknown> {
	const err = task.raise.error;
	if (typeof err === 'string') {
		return { errorType: err, errorStatus: 500, errorTitle: '', errorDetail: '', errorInstance: '' };
	}
	return {
		errorType: err.type,
		errorStatus: err.status,
		errorTitle: err.title ?? '',
		errorDetail: err.detail ?? '',
		errorInstance: err.instance ?? ''
	};
}

function runDataFromTask(task: RunTask): Record<string, unknown> {
	const run = task.run;
	if ('container' in run) {
		const c = run.container;
		return {
			runType: 'container',
			image: c.image,
			pullPolicy: c.pullPolicy,
			command: c.command ?? '',
			containerName: c.name ?? '',
			environment: entriesFromRecord(c.environment),
			arguments: (c.arguments ?? []).join('\n'),
			volumesJson: stringifyJsonField(c.volumes),
			lifetimeCleanup: c.lifetime?.cleanup ?? ''
		};
	}
	if ('shell' in run) {
		return {
			runType: 'shell',
			command: run.shell.command,
			environment: entriesFromRecord(run.shell.environment),
			arguments: (run.shell.arguments ?? []).join('\n')
		};
	}
	if ('script' in run) {
		return {
			runType: 'script',
			language: run.script.language,
			code: run.script.code ?? '',
			sourceEndpoint: run.script.source?.endpoint ?? '',
			environment: entriesFromRecord(run.script.environment),
			arguments: (run.script.arguments ?? []).join('\n')
		};
	}
	return { runType: 'script', language: 'js', code: '' };
}

function childWorkflowDataFromTask(task: RunTask): Record<string, unknown> {
	const run = task.run as { workflow: { type: string; input?: Record<string, unknown> } };
	const inputVal = run.workflow.input;
	let childInput = '${ . }';
	if (inputVal && typeof inputVal === 'object' && 'value' in inputVal) {
		childInput = String((inputVal as Record<string, unknown>).value);
	}
	return {
		workflowType: run.workflow.type,
		childInput,
		await: task.await !== false
	};
}
