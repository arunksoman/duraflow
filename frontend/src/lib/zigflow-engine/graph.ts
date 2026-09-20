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
	EventEntry,
	BranchEntry,
	SwitchMode
} from '../components/builder/builderConfig';
import type { WorkflowNodeType, InputField } from '../types';
import { applyWorkflowSchedule, readWorkflowSchedule, type WorkflowSchedule } from './schedule';
import { toSlug, uniqueSlug } from './slug';
import { orderNodesInScope, layoutScope } from './layout';
import {
	ROOT_SCOPE_ID,
	forScopeKey,
	tryScopeKey,
	catchScopeKey,
	forkBranchScopeKey,
	switchCaseScopeKey
} from './scopeKey';

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
	return {
		document: documentHeader,
		...(input ? { input } : {}),
		...(scheduleParts.schedule ? { schedule: scheduleParts.schedule } : {}),
		do: scopeToTaskList(graph, ROOT_SCOPE_ID)
	};
}

function scopeToTaskList(graph: WorkflowGraph, scopeId: string): TaskList {
	const scope = graph.scopes[scopeId];
	if (!scope) return [];

	const ordered = orderNodesInScope(scope.nodes, scope.edges).filter(
		(n) => n.type !== 'start' && n.type !== 'end'
	);

	// Assign every sibling's task name up front so `switch` cases can resolve `then` targets
	// (forward or backward references) before task bodies are built.
	const usedNames = new Set<string>();
	const idToName = new Map<string, string>();
	for (const node of ordered) {
		const name = uniqueSlug((node.data?.label as string) ?? node.type ?? 'task', usedNames);
		idToName.set(node.id, name);
	}

	// A branch-mode switch's cases don't reference siblings that already exist — each one *becomes*
	// a sibling task holding that branch's body. Those names are allocated here, after every real
	// node's, so a branch can never steal a name a task already has.
	const branchNames = new Map<string, string[]>();
	for (const node of ordered) {
		if (!isBranchModeSwitch(node)) continue;
		branchNames.set(
			node.id,
			switchCasesOf(node).map((c) => uniqueSlug(c.name || 'case', usedNames))
		);
	}

	const list: TaskList = [];

	// Start node variables (root scope only) become a synthetic leading `init` set task — there
	// is no real "start" task in the DSL, this is purely a canvas convenience.
	if (scopeId === ROOT_SCOPE_ID) {
		const startNode = scope.nodes.find((n) => n.type === 'start');
		const vars = ((startNode?.data?.variables as VarEntry[]) ?? []).filter((v) => v.key);
		if (vars.length > 0) list.push({ init: { set: recordFromEntries(vars) } });
	}

	for (const node of ordered) {
		const name = idToName.get(node.id)!;

		// A branch-mode switch is the one node whose task can't be built from the node alone: its
		// cases point at sibling tasks this function is itself allocating, so it needs the branch
		// names and the scope ordering that only exist here.
		if (isBranchModeSwitch(node)) {
			const names = branchNames.get(node.id)!;
			list.push({
				[name]: {
					...taskBaseFromData((node.data ?? {}) as Record<string, unknown>),
					switch: branchCasesToAst(node, graph, scopeId, names, ordered, idToName)
				}
			});
			// Emitted immediately after their switch, and before whatever it converges onto, so each
			// branch's `then:` is a forward reference to a task really later in the list.
			list.push(...switchBranchTasks(node, graph, scopeId, names, ordered, idToName));
			continue;
		}

		list.push({ [name]: nodeToTask(node, graph, scopeId, idToName) });
	}
	return list;
}

function switchModeOf(node: Node): SwitchMode {
	// Anything without an explicit mode is a switch the builder itself made (or one loaded before
	// this field existed); `branches` is what those round-trip to.
	return (
		((node.data as Record<string, unknown> | undefined)?.switchMode as SwitchMode) ?? 'branches'
	);
}

function switchCasesOf(node: Node): CaseEntry[] {
	const cases = (node.data as Record<string, unknown> | undefined)?.cases;
	return Array.isArray(cases) ? (cases as CaseEntry[]) : [];
}

function isBranchModeSwitch(node: Node): boolean {
	return node.type === 'switch' && switchModeOf(node) === 'branches';
}

/**
 * Where a branch-mode switch's branches go once they finish: the task that follows the switch in
 * its own scope, or `exit` when nothing does (the switch is last, so leaving the scope *is* what
 * comes next — at the root that ends the workflow, inside a `for`/`try`/fork branch it ends that
 * body's iteration).
 *
 * Every branch gets this same target, which is what makes the DSL a diamond rather than a chain:
 * without it, `electronic`'s body would finish and fall straight through into `physical`'s.
 */
function switchConvergeTarget(
	node: Node,
	ordered: Node[],
	idToName: Map<string, string>
): FlowDirective {
	const next = ordered[ordered.indexOf(node) + 1];
	return next ? (idToName.get(next.id) ?? 'exit') : 'exit';
}

/**
 * The sibling tasks a branch-mode switch's cases point at — one per case, each holding that
 * branch's lane and each carrying the converge `then:`. A lane holding exactly one task already
 * named after the branch emits bare rather than `do:`-wrapped — the same round-trip convention
 * fork branches use, see `nodeToTask`'s fork case. An empty lane emits nothing at all and its
 * case points straight at the converge target, so an untouched "otherwise" costs no task.
 */
function switchBranchTasks(
	node: Node,
	graph: WorkflowGraph,
	scopeId: string,
	names: string[],
	ordered: Node[],
	idToName: Map<string, string>
): TaskList {
	const converge = switchConvergeTarget(node, ordered, idToName);
	const tasks: TaskList = [];

	switchCasesOf(node).forEach((c, i) => {
		const body = scopeToTaskList(graph, switchCaseScopeKey(scopeId, node.id, c.id ?? String(i)));
		if (body.length === 0) return;
		const name = names[i];
		if (body.length === 1) {
			const [onlyName, only] = Object.entries(body[0])[0];
			if (onlyName === name) {
				tasks.push({ [name]: { ...only, then: converge } });
				return;
			}
		}
		tasks.push({ [name]: { do: body, then: converge } });
	});

	return tasks;
}

/**
 * A branch-mode case's `then:` — the sibling task holding its branch, or the converge target
 * directly when the branch is empty (there is no task to route through).
 */
function branchCasesToAst(
	node: Node,
	graph: WorkflowGraph,
	scopeId: string,
	names: string[],
	ordered: Node[],
	idToName: Map<string, string>
): SwitchCase[] {
	const converge = switchConvergeTarget(node, ordered, idToName);
	return switchCasesOf(node).map((c, i) => {
		const empty =
			scopeToTaskList(graph, switchCaseScopeKey(scopeId, node.id, c.id ?? String(i))).length === 0;
		const when = c.condition?.trim();
		const body: SwitchCaseBody = { then: empty ? converge : names[i] };
		if (when) body.when = when;
		return { [toSlug(c.name) || 'case']: body };
	});
}

function nodeToTask(
	node: Node,
	graph: WorkflowGraph,
	scopeId: string,
	idToName: Map<string, string>
): TaskNode {
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
		case 'switch':
			return { ...base, switch: switchCasesFromData(data, idToName) };
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
				do: scopeToTaskList(graph, childScope)
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
				const body = scopeToTaskList(graph, childScope);
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
				try: scopeToTaskList(graph, tryScope),
				catch: { as: (data.catchAs as string) || 'error', do: scopeToTaskList(graph, catchScope) }
			};
			return tryTask;
		}
		case 'do': {
			const childScope = forScopeKey(scopeId, node.id);
			return { ...base, do: scopeToTaskList(graph, childScope) };
		}
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

function resolveThenToAst(thenVal: string, idToName: Map<string, string>): FlowDirective {
	if (thenVal === 'continue' || thenVal === 'exit' || thenVal === 'end') return thenVal;
	const resolved = idToName.get(thenVal);
	if (resolved) return resolved;
	// `thenVal` is an internal canvas node-id, not a real task name — either it was never a valid
	// node-id reference, or (schema requires `then` targets stay within the same scope/depth) it
	// points at a node outside this switch's own scope. Emitting the raw id would produce invalid
	// DSL a Temporal worker can't resolve; falling back to `continue` keeps the workflow valid.
	return 'continue';
}

function switchCasesFromData(
	data: Record<string, unknown>,
	idToName: Map<string, string>
): SwitchCase[] {
	const cases = (data.cases as CaseEntry[]) ?? [];
	return cases.map((c) => {
		const when = c.condition?.trim();
		const body: SwitchCaseBody = { then: resolveThenToAst(c.then, idToName) };
		if (when) body.when = when;
		return { [toSlug(c.name) || 'case']: body };
	});
}

function waitFromData(data: Record<string, unknown>) {
	if ((data.waitMode as string) === 'until') {
		return { until: (data.until as string) || '' };
	}
	const d = definedEntries({
		days: data.days as number,
		hours: data.hours as number,
		minutes: data.minutes as number,
		seconds: data.seconds as number
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
	buildScope(doc.do, ROOT_SCOPE_ID, scopes);
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

function buildScope(list: TaskList, scopeId: string, scopesOut: Record<string, ScopeGraph>): void {
	const nodes: Node[] = [];
	const nameToId = new Map<string, string>();

	// A switch whose cases route through dedicated sibling tasks that all converge on the same
	// target is the shape this engine writes, and it loads back as branch lanes rather than as
	// those siblings — so those tasks get no node of their own. Anything else stays flat.
	const branchGroups = detectSwitchBranchGroups(list);
	const consumed = new Set(
		[...branchGroups.values()].flatMap((g) => g.branches.map((b) => b.taskName))
	);
	const visible = list.filter((entry) => !consumed.has(Object.keys(entry)[0]));

	// Pass 1: allocate a node id + type per task so forward/backward `switch.then` references
	// and nested-scope keys are available while building task bodies in pass 2.
	for (const entry of visible) {
		const [name, task] = Object.entries(entry)[0];
		const id = newNodeId();
		nameToId.set(name, id);
		nodes.push({
			id,
			type: taskKindToNodeType(task),
			position: { x: 0, y: 0 },
			data: { label: name }
		});
	}

	// Pass 2: fill each node's data, recursing into nested scopes as needed.
	nodes.forEach((node, idx) => {
		const [taskName, task] = Object.entries(visible[idx])[0];
		node.data = {
			type: node.type,
			...node.data,
			...dataFromTask(task, node.id, scopeId, nameToId, scopesOut, branchGroups.get(taskName))
		};
	});

	const edges: Edge[] = [];
	for (let i = 0; i < nodes.length - 1; i++) {
		edges.push({
			id: `e-${nodes[i].id}-${nodes[i + 1].id}`,
			source: nodes[i].id,
			target: nodes[i + 1].id
		});
	}

	if (scopeId === ROOT_SCOPE_ID) {
		const lastRealNode = nodes[nodes.length - 1];

		const startNode: Node = {
			id: 'start',
			type: 'start',
			position: { x: 0, y: 0 },
			data: { type: 'start', label: 'Start', variables: [] as VarEntry[] },
			deletable: false
		};
		nodes.unshift(startNode);
		if (nodes.length > 1) {
			edges.unshift({ id: `e-start-${nodes[1].id}`, source: 'start', target: nodes[1].id });
		}

		// Every workflow gets an explicit `End` node too, same as `Start` — otherwise the last real
		// task's chain trails off with nothing after it, which reads as open-ended/unfinished rather
		// than "this is where the workflow terminates". Purely a canvas convenience like `Start`:
		// filtered out of the real task list in `scopeToTaskList` above, never touches the DSL.
		const endNode: Node = {
			id: 'end',
			type: 'end',
			position: { x: 0, y: 0 },
			data: { type: 'end', label: 'End' },
			deletable: false
		};
		const lastNodeBeforeEnd = lastRealNode ?? startNode;
		nodes.push(endNode);
		edges.push({
			id: `e-${lastNodeBeforeEnd.id}-end`,
			source: lastNodeBeforeEnd.id,
			target: 'end'
		});
	}

	layoutScope(nodes, edges);
	scopesOut[scopeId] = { nodes, edges };
}

/** One case of a branch-mode switch, paired with the sibling task that holds its body. */
interface SwitchBranch {
	caseName: string;
	when?: string;
	/** Name of the sibling task carrying this branch, or undefined when the branch is empty. */
	taskName?: string;
	body: TaskList;
	/** True when `body` came from a bare task rather than a `do:` wrapper — see `switchBranchTasks`. */
	bare: boolean;
}

interface SwitchBranchGroup {
	branches: SwitchBranch[];
	/** Every branch task's shared `then:`. Not used to build the canvas — it's re-derived on save
	 * from wherever the switch sits — but matching it is what proves this is the branch shape. */
	converge: FlowDirective;
}

/**
 * Finds the switches in one task list that are really branch-mode — the shape `switchBranchTasks`
 * writes — and pairs each case with the sibling task holding its body.
 *
 * The shape has to be recognised exactly, because getting it wrong in either direction is bad: a
 * false positive swallows sibling tasks the author wrote as ordinary steps, and a false negative
 * turns a diagram the user built out of lanes back into a flat chain the next time they open it.
 * So all of the following must hold, and any switch failing them falls back to `jump` mode with
 * nothing rewritten:
 *
 *  - every case's `then` is either a sibling task name or the one shared converge directive;
 *  - the branch tasks sit immediately after the switch, contiguous, in case order;
 *  - each is referenced by exactly one case;
 *  - every branch task carries a `then:`, all of them the same, and that target is the task right
 *    after the last branch, or `exit`/`end` when nothing follows.
 *
 * That last rule is the load-bearing one: it's what distinguishes "these siblings are this
 * switch's branches" from "these siblings are ordinary tasks a case happens to jump into", which
 * is exactly the `example/switch.yaml` case — its handlers have no `then:` and fall through into
 * each other, so it stays flat.
 */
function detectSwitchBranchGroups(list: TaskList): Map<string, SwitchBranchGroup> {
	const groups = new Map<string, SwitchBranchGroup>();
	const names = list.map((entry) => Object.keys(entry)[0]);

	list.forEach((entry, index) => {
		const [switchName, task] = Object.entries(entry)[0];
		if (!('switch' in task)) return;

		const cases = (task as SwitchTask).switch.map((c) => Object.entries(c)[0]);
		if (cases.length === 0) return;

		// Walk the tasks right after the switch, consuming one per case whose `then` names it — a
		// case whose branch was empty emitted no task and is simply skipped here. A candidate only
		// counts if it carries a `then:` and that `then:` agrees with the ones already consumed,
		// which is what stops the converge target itself (a task that may well have a `then:` of its
		// own) from being mistaken for the last branch.
		const branchTaskNames: string[] = [];
		let converge: FlowDirective | undefined;
		let cursor = index + 1;

		for (const [, body] of cases) {
			if (names[cursor] !== body.then) continue;
			const candidate = Object.values(list[cursor])[0] as TaskNode;
			if (candidate.then === undefined) continue;
			if (converge === undefined) converge = candidate.then;
			else if (candidate.then !== converge) continue;
			branchTaskNames.push(body.then);
			cursor++;
		}

		if (branchTaskNames.length === 0 || converge === undefined) return;

		// The converge target has to be the task immediately after the last branch — or, when the
		// switch group ends the list, a directive that leaves the scope.
		const after = names[cursor];
		const convergeIsCorrect = after
			? converge === after
			: converge === 'exit' || converge === 'end' || converge === 'continue';
		if (!convergeIsCorrect) return;

		// Every remaining case must point at the converge target (an empty branch). A case going
		// anywhere else — ending the workflow, or jumping somewhere unrelated — means this isn't the
		// shape we write, and drawing it as a branch that rejoins the chain would be a lie.
		if (cases.some(([, body]) => body.then !== converge && !branchTaskNames.includes(body.then)))
			return;

		let taken = 0;
		const branches: SwitchBranch[] = cases.map(([caseName, body]) => {
			if (!branchTaskNames.includes(body.then)) {
				return { caseName, when: body.when, body: [], bare: false };
			}
			const taskName = branchTaskNames[taken];
			const branchTask = Object.values(list[index + 1 + taken])[0] as TaskNode;
			taken++;
			// The converge `then:` is the engine's own bookkeeping — stripped here so it never
			// reaches the canvas, and re-derived on save from wherever the switch then sits.
			const rest = { ...branchTask } as TaskNode & { then?: FlowDirective };
			delete rest.then;
			const bare = !isBareDoWrapper(branchTask);
			return {
				caseName,
				when: body.when,
				taskName,
				body: bare ? [{ [taskName]: rest as TaskNode }] : (rest as { do: TaskList }).do,
				bare
			};
		});

		groups.set(switchName, { branches, converge });
	});

	return groups;
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
	nameToId: Map<string, string>,
	scopesOut: Record<string, ScopeGraph>,
	branchGroup?: SwitchBranchGroup
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
			// A branch is the `{ do: [...] }` grouping convention only when `do` is its *sole*
			// discriminator key — a `for` task also carries a `do` key (its body), so checking
			// `'do' in branchTask` alone wrongly unwraps a bare-`for` branch and silently drops its
			// `for`/`while` wrapper. Any other real task type present means this is a bare task branch.
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
		if (branchGroup) {
			const cases: CaseEntry[] = branchGroup.branches.map((b) => {
				const id = crypto.randomUUID();
				buildScope(b.body, switchCaseScopeKey(scopeId, nodeId, id), scopesOut);
				// `then` is derived on save from where the switch sits, so it's parked at `continue`
				// rather than carrying a stale task name around in the node's data.
				return { id, name: b.caseName, condition: b.when ?? '', then: 'continue' };
			});
			return { ...base, switchMode: 'branches' satisfies SwitchMode, cases };
		}
		return {
			...base,
			switchMode: 'jump' satisfies SwitchMode,
			cases: switchCasesToData(task, nameToId)
		};
	}
	if ('try' in task) {
		buildScope(task.try, tryScopeKey(scopeId, nodeId), scopesOut);
		buildScope(task.catch.do, catchScopeKey(scopeId, nodeId), scopesOut);
		return { ...base, catchAs: task.catch.as ?? 'error' };
	}
	if ('wait' in task) return { ...base, ...waitDataFromTask(task) };
	if ('do' in task) {
		buildScope(task.do, forScopeKey(scopeId, nodeId), scopesOut);
		return base;
	}
	return base;
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

function resolveThenFromAst(then: string, nameToId: Map<string, string>): string {
	if (then === 'continue' || then === 'exit' || then === 'end') return then;
	return nameToId.get(then) ?? then;
}

function switchCasesToData(task: SwitchTask, nameToId: Map<string, string>): CaseEntry[] {
	return task.switch.map((c) => {
		const [name, body] = Object.entries(c)[0];
		return { name, condition: body.when ?? '', then: resolveThenFromAst(body.then, nameToId) };
	});
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
