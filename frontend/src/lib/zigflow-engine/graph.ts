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
	workflowScopeKey
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

	const all = orderNodesInScope(scope.nodes, scope.edges).filter(
		(n) => n.type !== 'start' && n.type !== 'end'
	);

	// A named workflow is not a step of the flow it is drawn beside — it is a separate Temporal
	// workflow declared in the same document, so it never joins the chain and is emitted after it.
	// (Only the root list can hold these; nested scopes never produce `workflow` nodes.)
	const ordered = all.filter((n) => n.type !== 'workflow');
	const workflows = all.filter((n) => n.type === 'workflow');

	// Assign every sibling's task name up front so `switch` cases can resolve `then` targets
	// (forward or backward references) before task bodies are built. Named workflows are in the
	// same namespace — a case jumping at one names it exactly like it names a plain task.
	const usedNames = new Set<string>();
	const idToName = new Map<string, string>();
	for (const node of [...ordered, ...workflows]) {
		const name = uniqueTaskName((node.data?.label as string) ?? node.type ?? 'task', usedNames);
		idToName.set(node.id, name);
	}

	const list: TaskList = [];

	// Start node variables (root scope only) become a synthetic leading `init` set task — there
	// is no real "start" task in the DSL, this is purely a canvas convenience.
	if (scopeId === ROOT_SCOPE_ID) {
		list.push(...initTaskFor(scope.nodes.find((n) => n.type === 'start')));
	}

	for (const node of ordered) {
		const name = idToName.get(node.id)!;

		// A switch is the one node whose task can't be built from the node alone: its cases name
		// siblings, which only this function knows the allocated names of.
		if (node.type === 'switch') {
			list.push({
				[name]: {
					...taskBaseFromData((node.data ?? {}) as Record<string, unknown>),
					switch: switchCasesToAst(node, graph, idToName)
				}
			});
			continue;
		}

		list.push({ [name]: nodeToTask(node, graph, scopeId) });
	}

	for (const node of workflows) {
		list.push({ [idToName.get(node.id)!]: workflowTask(node, graph) });
	}

	return list;
}

/**
 * The leading `init: set: {...}` a Start node's variables become, or nothing when it has none.
 * Shared by the primary workflow's Start node and every named workflow's, which is the whole point
 * of a named workflow having a Start of its own: it seeds `$data` for its own run.
 */
function initTaskFor(startNode: Node | undefined): TaskList {
	const vars = ((startNode?.data?.variables as VarEntry[]) ?? []).filter((v) => v.key);
	return vars.length > 0 ? [{ init: { set: recordFromEntries(vars) } }] : [];
}

/**
 * A named workflow: `<name>: { do: [...] }`. Its Start node *is* the node this is built from, so
 * its variables lead the body — the same `init: set:` convention the primary workflow's Start uses.
 */
function workflowTask(node: Node, graph: WorkflowGraph): TaskNode {
	const data = (node.data ?? {}) as Record<string, unknown>;
	return {
		...taskBaseFromData(data),
		do: [...initTaskFor(node), ...scopeToTaskList(graph, workflowScopeKey(node.id))]
	} as TaskNode;
}

/**
 * Where one case sends the run, as the `then:` the DSL wants: a flow directive as written, or the
 * name of the task it jumps at. The jump is re-resolved through the target *node* so it survives
 * that task being renamed, falling back to the name the document had.
 *
 * A target outside the switch's own scope — a named workflow, which lives at the root while the
 * switch may not — is resolved by name from the root scope instead, since only same-scope siblings
 * are in `idToName`.
 */
function caseTargetToAst(
	c: CaseEntry,
	graph: WorkflowGraph,
	idToName: Map<string, string>
): FlowDirective {
	if (c.routing !== 'task') return c.routing;
	if (c.targetNodeId) {
		const sibling = idToName.get(c.targetNodeId);
		if (sibling) return sibling;
		const workflow = workflowNameById(graph, c.targetNodeId);
		if (workflow) return workflow;
	}
	// A `targetNodeId` that no longer resolves means the task it named has been deleted — a
	// dangling `then:` is DSL no worker can run, so the case falls back to carrying on instead.
	return c.taskName ?? 'continue';
}

/** The task name a root-level named workflow node is emitted under, by node id. */
function workflowNameById(graph: WorkflowGraph, nodeId: string): string | undefined {
	const node = graph.scopes[ROOT_SCOPE_ID]?.nodes.find(
		(n) => n.id === nodeId && n.type === 'workflow'
	);
	return node ? toTaskName((node.data?.label as string) ?? '') : undefined;
}

function switchCasesToAst(
	node: Node,
	graph: WorkflowGraph,
	idToName: Map<string, string>
): SwitchCase[] {
	return switchCasesOf(node).map((c) => {
		const when = c.condition?.trim();
		const body: SwitchCaseBody = { then: caseTargetToAst(c, graph, idToName) };
		if (when) body.when = when;
		return { [toTaskName(c.name) || 'case']: body };
	});
}

function nodeToTask(node: Node, graph: WorkflowGraph, scopeId: string): TaskNode {
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

	// Pass 1: allocate a node id + type per task so forward/backward `switch.then` references
	// and nested-scope keys are available while building task bodies in pass 2.
	for (const entry of list) {
		const [name, task] = Object.entries(entry)[0];
		const id = newNodeId();
		nameToId.set(name, id);
		nodes.push({
			id,
			type: taskKindToNodeType(task, scopeId),
			position: { x: 0, y: 0 },
			data: { label: name }
		});
	}

	// Pass 2: fill each node's data, recursing into nested scopes as needed.
	nodes.forEach((node, idx) => {
		const [, task] = Object.entries(list[idx])[0];
		node.data = {
			type: node.type,
			...node.data,
			...dataFromTask(task, node.id, scopeId, nameToId, scopesOut)
		};
	});

	// Named workflows are declared beside the flow, not sequenced into it: each runs on its own, so
	// it is left out of the chain entirely rather than wired between its neighbours.
	const chain = nodes.filter((n) => n.type !== 'workflow');

	const edges: Edge[] = [];
	for (let i = 0; i < chain.length - 1; i++) {
		edges.push({
			id: `e-${chain[i].id}-${chain[i + 1].id}`,
			source: chain[i].id,
			target: chain[i + 1].id
		});
	}

	if (scopeId === ROOT_SCOPE_ID) {
		const lastRealNode = chain[chain.length - 1];

		const startNode: Node = {
			id: 'start',
			type: 'start',
			position: { x: 0, y: 0 },
			data: { type: 'start', label: 'Start', variables: [] as VarEntry[] },
			deletable: false
		};
		nodes.unshift(startNode);
		if (chain.length > 0) {
			edges.unshift({ id: `e-start-${chain[0].id}`, source: 'start', target: chain[0].id });
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
 * `then:` is either one of the three flow directives or the name of a task, and both are kept
 * exactly as written. The name is resolved to a node later (`dataFromTask`), so a jump survives its
 * target being renamed; an unresolvable name stays as `taskName` so the document round-trips
 * unchanged rather than losing the jump.
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
 * Which node a loaded task becomes. The one context-sensitive case is `do:`: at the root of the
 * document it declares a whole separate Temporal workflow (named by its task key, drawn with its
 * own Start and End), while nested inside a `for`/`try`/`fork` body it is only a sequential group.
 */
function taskKindToNodeType(task: TaskNode, scopeId: string): WorkflowNodeType {
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
	if ('do' in task) return scopeId === ROOT_SCOPE_ID ? 'workflow' : 'do';
	throw new Error('Unknown task shape while converting DSL to the canvas');
}

function dataFromTask(
	task: TaskNode,
	nodeId: string,
	scopeId: string,
	nameToId: Map<string, string>,
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
		const cases: CaseEntry[] = planSwitchCases(task).map((p) => {
			const targetNodeId = p.routing === 'task' ? nameToId.get(p.taskName ?? '') : undefined;
			return {
				id: crypto.randomUUID(),
				name: p.caseName,
				condition: p.when ?? '',
				routing: p.routing,
				...(p.taskName ? { taskName: p.taskName } : {}),
				...(targetNodeId ? { targetNodeId } : {})
			};
		});
		return { ...base, cases };
	}
	if ('try' in task) {
		buildScope(task.try, tryScopeKey(scopeId, nodeId), scopesOut);
		buildScope(task.catch.do, catchScopeKey(scopeId, nodeId), scopesOut);
		return { ...base, catchAs: task.catch.as ?? 'error' };
	}
	if ('wait' in task) return { ...base, ...waitDataFromTask(task) };
	if ('do' in task) {
		// A root-level `do:` is a named workflow, whose body lives under its own scope key. Its Start
		// node's `variables` behave exactly like the primary workflow's Start: emitted as a leading
		// `init: set:` (see `initTaskFor`) and read back as an ordinary `set` node, not re-absorbed.
		buildScope(
			task.do,
			scopeId === ROOT_SCOPE_ID ? workflowScopeKey(nodeId) : forScopeKey(scopeId, nodeId),
			scopesOut
		);
		return scopeId === ROOT_SCOPE_ID ? { ...base, variables: [] as VarEntry[] } : base;
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
