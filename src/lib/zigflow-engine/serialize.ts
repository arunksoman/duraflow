import { Document, Scalar } from 'yaml';
import type {
	CallTask,
	EventConsumptionStrategy,
	EventFilter,
	ForTask,
	ForkTask,
	ListenTask,
	RaiseError,
	RaiseTask,
	RunConfig,
	RunTask,
	SetTask,
	SwitchTask,
	TaskBase,
	TaskList,
	TaskNode,
	TryTask,
	WaitTask,
	ZigflowDocument,
	ZigflowDocumentHeader
} from './ast';

type PathSegment = string | number;

interface BuildCtx {
	/** Paths (into the final plain object) whose string scalar must render as `|` block-literal. */
	blockLiteralPaths: PathSegment[][];
}

function definedEntries<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

// ── Document header ──────────────────────────────────────────────────────

function buildHeader(header: ZigflowDocumentHeader): Record<string, unknown> {
	return definedEntries({
		dsl: header.dsl,
		taskQueue: header.taskQueue,
		workflowType: header.workflowType,
		version: header.version,
		title: header.title,
		summary: header.summary,
		tags: header.tags,
		metadata: header.metadata
	});
}

// ── Task list / task dispatch ────────────────────────────────────────────

function buildTaskList(
	list: TaskList,
	path: PathSegment[],
	ctx: BuildCtx
): Record<string, unknown>[] {
	return list.map((entry, i) => {
		const [name, task] = Object.entries(entry)[0];
		return { [name]: buildTask(task, [...path, i, name], ctx) };
	});
}

function buildTask(task: TaskNode, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	const base = task as TaskBase;
	let body: Record<string, unknown>;

	if ('call' in task) body = buildCall(task, path, ctx);
	else if ('for' in task) body = buildFor(task, path, ctx);
	else if ('fork' in task) body = buildFork(task, path, ctx);
	else if ('listen' in task) body = buildListen(task);
	else if ('raise' in task) body = buildRaise(task);
	else if ('run' in task) body = buildRun(task, path, ctx);
	else if ('set' in task) body = buildSet(task);
	else if ('switch' in task) body = buildSwitch(task);
	else if ('try' in task) body = buildTry(task, path, ctx);
	else if ('wait' in task) body = buildWait(task);
	else if ('do' in task) body = { do: buildTaskList(task.do, [...path, 'do'], ctx) };
	else throw new Error(`Unknown task shape at ${path.join('/')}`);

	return {
		...(base.if !== undefined ? { if: base.if } : {}),
		...body,
		...definedEntries({
			input: base.input,
			output: base.output,
			export: base.export,
			metadata: base.metadata,
			then: base.then
		})
	};
}

// ── Call (http only, per product decision) ───────────────────────────────

function buildCall(task: CallTask, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	const { method, endpoint, headers, query, body, output, redirect } = task.with;
	if (typeof body === 'string' && body.includes('\n')) {
		ctx.blockLiteralPaths.push([...path, 'with', 'body']);
	}
	return {
		call: 'http',
		with: definedEntries({
			method,
			endpoint,
			headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
			query: query && Object.keys(query).length > 0 ? query : undefined,
			body,
			output: output && output !== 'content' ? output : undefined,
			redirect: redirect === true ? true : undefined
		})
	};
}

// ── Do handled inline in buildTask (falls through to the `do` branch) ────

// ── For ──────────────────────────────────────────────────────────────────

function buildFor(task: ForTask, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	return {
		for: definedEntries({
			each: task.for.each ?? 'item',
			at: task.for.at ?? 'index',
			in: task.for.in
		}),
		...(task.while ? { while: task.while } : {}),
		do: buildTaskList(task.do, [...path, 'do'], ctx)
	};
}

// ── Fork ─────────────────────────────────────────────────────────────────

function buildFork(task: ForkTask, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	return {
		fork: {
			...(task.fork.compete === true ? { compete: true } : {}),
			branches: buildTaskList(task.fork.branches, [...path, 'fork', 'branches'], ctx)
		}
	};
}

// ── Listen ───────────────────────────────────────────────────────────────

function buildEventFilter(f: EventFilter): Record<string, unknown> {
	return { with: definedEntries({ ...f.with }) };
}

function buildEventStrategy(strategy: EventConsumptionStrategy): Record<string, unknown> {
	if ('one' in strategy) return { one: buildEventFilter(strategy.one) };
	if ('any' in strategy) return { any: strategy.any.map(buildEventFilter) };
	return { all: strategy.all.map(buildEventFilter) };
}

function buildListen(task: ListenTask): Record<string, unknown> {
	return {
		listen: definedEntries({
			to: buildEventStrategy(task.listen.to),
			read: task.listen.read
		})
	};
}

// ── Raise ────────────────────────────────────────────────────────────────

function buildRaiseError(e: RaiseError): Record<string, unknown> {
	return definedEntries({
		type: e.type,
		status: e.status,
		instance: e.instance,
		title: e.title,
		detail: e.detail
	});
}

function buildRaise(task: RaiseTask): Record<string, unknown> {
	const err = task.raise.error;
	return { raise: { error: typeof err === 'string' ? err : buildRaiseError(err) } };
}

// ── Run ──────────────────────────────────────────────────────────────────

function buildRunConfig(
	run: RunConfig,
	path: PathSegment[],
	ctx: BuildCtx
): Record<string, unknown> {
	if ('container' in run) {
		const c = run.container;
		return {
			container: definedEntries({
				image: c.image,
				pullPolicy: c.pullPolicy,
				name: c.name,
				command: c.command,
				volumes: c.volumes,
				environment: c.environment,
				arguments: c.arguments,
				lifetime: c.lifetime
			})
		};
	}
	if ('script' in run) {
		const s = run.script;
		if (typeof s.code === 'string' && s.code.includes('\n')) {
			ctx.blockLiteralPaths.push([...path, 'run', 'script', 'code']);
		}
		return {
			script: definedEntries({
				language: s.language,
				code: s.code,
				source: s.source,
				arguments: s.arguments,
				environment: s.environment
			})
		};
	}
	if ('shell' in run) {
		const sh = run.shell;
		if (typeof sh.command === 'string' && sh.command.includes('\n')) {
			ctx.blockLiteralPaths.push([...path, 'run', 'shell', 'command']);
		}
		return {
			shell: definedEntries({
				command: sh.command,
				arguments: sh.arguments,
				environment: sh.environment
			})
		};
	}
	const wf = run.workflow;
	return { workflow: definedEntries({ type: wf.type, input: wf.input }) };
}

function buildRun(task: RunTask, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	return {
		run: buildRunConfig(task.run, path, ctx),
		...(task.await === false ? { await: false } : {})
	};
}

// ── Set ──────────────────────────────────────────────────────────────────

function buildSet(task: SetTask): Record<string, unknown> {
	const keys = Object.keys(task.set ?? {});
	return { set: keys.length > 0 ? task.set : { result: '${ . }' } };
}

// ── Switch ───────────────────────────────────────────────────────────────

function buildSwitch(task: SwitchTask): Record<string, unknown> {
	return {
		switch: task.switch.map((c) => {
			const [name, body] = Object.entries(c)[0];
			return { [name]: definedEntries({ when: body.when, then: body.then }) };
		})
	};
}

// ── Try ──────────────────────────────────────────────────────────────────

function buildTry(task: TryTask, path: PathSegment[], ctx: BuildCtx): Record<string, unknown> {
	return {
		try: buildTaskList(task.try, [...path, 'try'], ctx),
		catch: {
			as: task.catch.as || 'error',
			do: buildTaskList(task.catch.do, [...path, 'catch', 'do'], ctx)
		}
	};
}

// ── Wait ─────────────────────────────────────────────────────────────────

function buildWait(task: WaitTask): Record<string, unknown> {
	if ('until' in task.wait) return { wait: { until: task.wait.until } };
	const d = definedEntries({
		days: task.wait.days,
		hours: task.wait.hours,
		minutes: task.wait.minutes,
		seconds: task.wait.seconds,
		milliseconds: task.wait.milliseconds
	});
	return { wait: Object.keys(d).length > 0 ? d : { seconds: 30 } };
}

// ── Public entry point ───────────────────────────────────────────────────

export function serializeZigflowDocument(doc: ZigflowDocument): string {
	const ctx: BuildCtx = { blockLiteralPaths: [] };
	const obj = {
		document: buildHeader(doc.document),
		do: buildTaskList(doc.do, ['do'], ctx)
	};

	const ydoc = new Document(obj);
	for (const path of ctx.blockLiteralPaths) {
		const node = ydoc.getIn(path, true);
		if (node instanceof Scalar && typeof node.value === 'string') {
			node.type = Scalar.BLOCK_LITERAL;
		}
	}
	return ydoc.toString({ lineWidth: 0 });
}
