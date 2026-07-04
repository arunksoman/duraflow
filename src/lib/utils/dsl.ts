import type { Node, Edge } from '@xyflow/svelte';
import type { WorkflowMeta } from '$lib/types';

// ── Local aliases ────────────────────────────────────────────────────

type VarEntry = { key: string; value: string };
type CaseEntry = { name: string; condition: string; then: string };
type EventEntry = { id: string; type: string; data?: string; acceptIf?: string };

// ── Utilities ────────────────────────────────────────────────────────

function toSlug(str: string): string {
	return (
		(str ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

function resolveNodeSlug(nodeId: string, allNodes: Node[]): string {
	const node = allNodes.find((n) => n.id === nodeId);
	if (!node) return nodeId;
	return toSlug((node.data?.label as string) ?? node.type ?? 'task');
}

/** Resolve a switch `then` value: flow directive or node-id → task slug. */
function resolveThen(then: string, allNodes: Node[]): string {
	const directives = ['continue', 'end', 'exit'];
	if (directives.includes(then)) return then;
	// If the stored value looks like a node id, resolve it; otherwise treat as a literal slug
	const byId = allNodes.find((n) => n.id === then);
	if (byId) {
		if (byId.type === 'end') return 'end';
		return toSlug((byId.data?.label as string) ?? byId.type ?? 'task');
	}
	return then || 'continue';
}

// ── DSL Builder class ────────────────────────────────────────────────

class DslBuilder {
	private lines: string[] = [];

	private push(...items: string[]): this {
		this.lines.push(...items);
		return this;
	}

	/** Emit raw lines — used by the outer generator for one-off blocks. */
	raw(...items: string[]): this {
		this.lines.push(...items);
		return this;
	}

	// ── Document header ──────────────────────────────────────────────

	document(meta: WorkflowMeta, workflowName: string): this {
		this.push(
			`document:`,
			`  dsl: '1.0.0-alpha5'`,
			`  namespace: ${meta.namespace || 'default'}`,
			`  name: ${workflowName}`,
			`  version: '${meta.version || '0.1.0'}'`
		);
		if (meta.taskQueue) this.push(`  taskQueue: ${meta.taskQueue}`);
		if (meta.workflowType) this.push(`  workflowType: ${meta.workflowType}`);
		this.push('', 'do:');
		return this;
	}

	// ── Data flow (input.from / output.as / export.as) ───────────────

	private dataFlow(data: Record<string, unknown>, indent: string): this {
		const inputFrom = (data.inputFrom as string) ?? '';
		const outputAs = (data.outputAs as string) ?? '';
		const exportAs = (data.exportAs as string) ?? '';

		if (inputFrom.trim()) {
			this.push(`${indent}input:`, `${indent}  from: ${inputFrom.trim()}`);
		}
		if (outputAs.trim()) {
			this.push(`${indent}output:`, `${indent}  as: ${outputAs.trim()}`);
		}
		if (exportAs.trim()) {
			this.push(`${indent}export:`, `${indent}  as: ${exportAs.trim()}`);
		}
		return this;
	}

	// ── Task emitters ────────────────────────────────────────────────

	call(taskId: string, data: Record<string, unknown>, allNodes: Node[]): this {
		const hdrs = ((data.headers as VarEntry[]) ?? []).filter((h) => h.key);
		const qry = ((data.query as VarEntry[]) ?? []).filter((q) => q.key);
		const bodyStr = ((data.body as string) ?? '').trim();
		const outputFmt = (data.output as string) ?? 'content';
		const redir = data.redirect === true;

		this.push(`  - ${taskId}:`, `      call: http`, `      with:`);
		this.push(`        method: ${data.method ?? 'get'}`);
		this.push(`        endpoint: ${data.endpoint ?? ''}`);

		if (hdrs.length > 0) {
			this.push(`        headers:`);
			for (const h of hdrs) this.push(`          ${h.key}: ${h.value}`);
		}
		if (qry.length > 0) {
			this.push(`        query:`);
			for (const q of qry) this.push(`          ${q.key}: ${q.value}`);
		}
		if (bodyStr) {
			const bodyLines = bodyStr.split('\n');
			if (bodyLines.length === 1) {
				this.push(`        body: ${bodyLines[0]}`);
			} else {
				this.push(`        body: |`);
				for (const l of bodyLines) this.push(`          ${l}`);
			}
		}
		if (outputFmt !== 'content') this.push(`        output: ${outputFmt}`);
		if (redir) this.push(`        redirect: true`);

		this.dataFlow(data, '      ');
		return this;
	}

	task(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`, `      call: http`, `      with:`);
		this.push(`        method: ${data.method ?? 'get'}`);
		this.push(`        endpoint: ${data.endpoint ?? ''}`);
		if (data.timeout) this.push(`        timeout: ${data.timeout}`);
		this.dataFlow(data, '      ');
		return this;
	}

	set(taskId: string, data: Record<string, unknown>): this {
		const vars = (data.variables as VarEntry[]) ?? [];
		const valid = vars.filter((v) => v.key);
		this.push(`  - ${taskId}:`, `      set:`);
		if (valid.length > 0) {
			for (const v of valid) this.push(`        ${v.key}: ${v.value || "''"}`);
		} else {
			this.push('        result: ${ . }');
		}
		this.dataFlow(data, '      ');
		return this;
	}

	switch(taskId: string, data: Record<string, unknown>, allNodes: Node[]): this {
		const cases = (data.cases as CaseEntry[]) ?? [];
		this.push(`  - ${taskId}:`, `      switch:`);
		for (const c of cases) {
			this.push(`        - ${c.name}:`);
			if (c.condition.trim()) this.push(`            when: ${c.condition.trim()}`);
			this.push(`            then: ${resolveThen(c.then, allNodes)}`);
		}
		this.dataFlow(data, '      ');
		return this;
	}

	for(taskId: string, data: Record<string, unknown>): this {
		const each = (data.each as string) || 'item';
		const at = (data.at as string) || 'index';
		const inExpr = (data.in as string) || '${ $input.items }';
		const whileExpr = (data.while as string) || '';

		this.push(`  - ${taskId}:`, `      for:`);
		this.push(`        each: ${each}`);
		this.push(`        at: ${at}`);
		this.push(`        in: ${inExpr}`);
		if (whileExpr.trim()) this.push(`        while: ${whileExpr.trim()}`);
		this.push(`        do:`, `          - step: {}`);
		this.dataFlow(data, '      ');
		return this;
	}

	fork(taskId: string, data: Record<string, unknown>, nexts: string[], allNodes: Node[]): this {
		const compete = data.compete === true;
		this.push(`  - ${taskId}:`, `      fork:`);
		if (compete) this.push(`        compete: true`);
		this.push(`        branches:`);
		if (nexts.length > 0) {
			for (const nid of nexts) {
				this.push(`          - ${resolveNodeSlug(nid, allNodes)}: {}`);
			}
		} else {
			this.push(`          - branch1: {}`, `          - branch2: {}`);
		}
		this.dataFlow(data, '      ');
		return this;
	}

	try(taskId: string, data: Record<string, unknown>): this {
		const catchAs = (data.catchAs as string) || 'error';
		this.push(
			`  - ${taskId}:`,
			`      try:`,
			`        do:`,
			`          - step: {}`,
			`      catch:`,
			`        errors:`,
			`          as: ${catchAs}`,
			`        do:`,
			`          - handleError: {}`
		);
		this.dataFlow(data, '      ');
		return this;
	}

	wait(taskId: string, data: Record<string, unknown>): this {
		const mode = (data.waitMode as string) ?? 'duration';
		this.push(`  - ${taskId}:`, `      wait:`);
		if (mode === 'until') {
			const until = (data.until as string) || '';
			this.push(`        until: ${until}`);
		} else {
			const days = Number(data.days ?? 0);
			const hours = Number(data.hours ?? 0);
			const minutes = Number(data.minutes ?? 0);
			const seconds = Number(data.seconds ?? 30);
			if (days) this.push(`        days: ${days}`);
			if (hours) this.push(`        hours: ${hours}`);
			if (minutes) this.push(`        minutes: ${minutes}`);
			if (seconds || (!days && !hours && !minutes)) this.push(`        seconds: ${seconds}`);
		}
		this.dataFlow(data, '      ');
		return this;
	}

	listen(taskId: string, data: Record<string, unknown>): this {
		const strategy = (data.strategy as string) || 'one';
		const events = (data.events as EventEntry[]) ?? [];
		this.push(`  - ${taskId}:`, `      listen:`, `        to:`, `          ${strategy}:`);
		if (events.length > 0) {
			for (const ev of events) {
				this.push(`            - with:`);
				this.push(`                id: ${ev.id}`);
				this.push(`                type: ${ev.type}`);
				if (ev.data) this.push(`                data: ${ev.data}`);
				if (ev.acceptIf) this.push(`                acceptIf: ${ev.acceptIf}`);
			}
		} else {
			this.push(`            - with:`, `                id: my-event`, `                type: signal`);
		}
		this.dataFlow(data, '      ');
		return this;
	}

	raise(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`, `      raise:`, `        error:`);
		this.push(`          type: ${data.errorType ?? 'https://serverlessworkflow.io/spec/1.0.0/errors/communication'}`);
		this.push(`          status: ${data.errorStatus ?? 500}`);
		if (data.errorTitle) this.push(`          title: ${data.errorTitle}`);
		if (data.errorDetail) this.push(`          detail: ${data.errorDetail}`);
		if (data.errorInstance) this.push(`          instance: ${data.errorInstance}`);
		return this;
	}

	run(taskId: string, data: Record<string, unknown>): this {
		const runType = (data.runType as string) ?? 'script';
		this.push(`  - ${taskId}:`, `      run:`);

		if (runType === 'script') {
			const lang = (data.language as string) ?? 'js';
			const code = (data.code as string) ?? '';
			this.push(`        script:`, `          language: ${lang}`, `          code: |`);
			for (const l of code.split('\n')) this.push(`            ${l}`);
		} else if (runType === 'shell') {
			this.push(`        shell:`, `          command: ${(data.command as string) || 'echo hello'}`);
		} else if (runType === 'container') {
			this.push(
				`        container:`,
				`          image: ${(data.image as string) || 'alpine:latest'}`,
				`          pullPolicy: ${(data.pullPolicy as string) || 'ifNotPresent'}`
			);
		} else if (runType === 'workflow') {
			this.push(
				`        workflow:`,
				`          type: ${(data.workflowType as string) || 'my-workflow-type'}`,
				'          input: ${ . }',
				`          await: true`
			);
		}
		this.dataFlow(data, '      ');
		return this;
	}

	childWorkflow(taskId: string, data: Record<string, unknown>): this {
		const input = (data.childInput as string) || '${ . }';
		const awaitChild = data.await !== false;
		this.push(
			`  - ${taskId}:`,
			`      run:`,
			`        workflow:`,
			`          type: ${(data.workflowType as string) || 'child-workflow-type'}`,
			`          input: ${input}`
		);
		if (!awaitChild) this.push(`          await: false`);
		this.dataFlow(data, '      ');
		return this;
	}

	do(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`, `      do:`, `        - step: {}`);
		this.dataFlow(data, '      ');
		return this;
	}

	/** Append an explicit `then:` continuation line to the last task block. */
	then(targetSlug: string): this {
		this.push(`      then: ${targetSlug}`);
		return this;
	}

	/** Blank separator between tasks. */
	sep(): this {
		this.push('');
		return this;
	}

	build(): string {
		return this.lines.join('\n');
	}
}

// ── Topological ordering ─────────────────────────────────────────────

function topoSort(nodes: Node[], edges: Edge[]): Node[] {
	const nextMap = new Map<string, string[]>();
	const prevSet = new Set<string>();

	for (const e of edges) {
		if (!nextMap.has(e.source)) nextMap.set(e.source, []);
		nextMap.get(e.source)!.push(e.target);
		prevSet.add(e.target);
	}

	const skip = new Set(['start', 'end']);
	const visited = new Set<string>();
	const ordered: Node[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		visited.add(id);
		const node = nodes.find((n) => n.id === id);
		if (node && !skip.has(node.type ?? '')) ordered.push(node);
		for (const nxt of nextMap.get(id) ?? []) visit(nxt);
	}

	// Start from roots (nodes with no incoming edges)
	for (const node of nodes) {
		if (!prevSet.has(node.id)) visit(node.id);
	}
	// Catch any disconnected nodes
	for (const node of nodes) visit(node.id);

	return ordered;
}

// ── Public entry point ───────────────────────────────────────────────

export function generateDsl(nodes: Node[], edges: Edge[], meta?: WorkflowMeta): string {
	if (nodes.filter((n) => n.type !== 'start' && n.type !== 'end').length === 0) {
		return [
			'# Add nodes to the canvas to generate DSL',
			'',
			'document:',
			"  dsl: '1.0.0-alpha5'",
			'  namespace: default',
			'  name: my-workflow',
			"  version: '0.1.0'",
			'',
			'do: []'
		].join('\n');
	}

	const nextMap = new Map<string, string[]>();
	for (const e of edges) {
		if (!nextMap.has(e.source)) nextMap.set(e.source, []);
		nextMap.get(e.source)!.push(e.target);
	}

	const ordered = topoSort(nodes, edges);
	const workflowName = toSlug((ordered[0]?.data?.label as string) ?? 'my-workflow');

	const effectiveMeta: WorkflowMeta = meta ?? {
		workflowType: '',
		taskQueue: '',
		namespace: 'default',
		version: '0.1.0',
		inputSchema: [],
		envVars: []
	};

	const builder = new DslBuilder();
	builder.document(effectiveMeta, workflowName);

	// Emit init set block if Start node has variables
	const startNode = nodes.find((n) => n.type === 'start');
	const startVars = ((startNode?.data?.variables as VarEntry[]) ?? []).filter((v) => v.key);
	if (startVars.length > 0) {
		builder.raw(`  - init:`, `      set:`);
		for (const v of startVars) builder.raw(`        ${v.key}: ${v.value || "''"}`);
		if (ordered.length > 0) {
			builder.then(toSlug((ordered[0].data?.label as string) ?? 'task'));
		}
		builder.sep();
	}

	for (let i = 0; i < ordered.length; i++) {
		const node = ordered[i];
		const data = (node.data ?? {}) as Record<string, unknown>;
		const type = node.type ?? 'task';
		const taskId = toSlug((data.label as string) ?? type);
		const nexts = nextMap.get(node.id) ?? [];
		// Filter out 'end' nodes from nexts for then: generation
		const realNexts = nexts.filter((nid) => {
			const n = nodes.find((x) => x.id === nid);
			return n && n.type !== 'end';
		});

		switch (type) {
			case 'call':
				builder.call(taskId, data, nodes);
				break;
			case 'task':
				builder.task(taskId, data);
				break;
			case 'set':
				builder.set(taskId, data);
				break;
			case 'switch':
				builder.switch(taskId, data, nodes);
				break;
			case 'for':
				builder.for(taskId, data);
				break;
			case 'fork':
				builder.fork(taskId, data, nexts, nodes);
				break;
			case 'try':
				builder.try(taskId, data);
				break;
			case 'wait':
				builder.wait(taskId, data);
				break;
			case 'listen':
				builder.listen(taskId, data);
				break;
			case 'raise':
				builder.raise(taskId, data);
				break;
			case 'run':
				builder.run(taskId, data);
				break;
			case 'childWorkflow':
				builder.childWorkflow(taskId, data);
				break;
			case 'do':
				builder.do(taskId, data);
				break;
			default:
				builder.raw(`  - ${taskId}:`, `      # unknown type: ${type}`);
		}

		// Auto-append then: for linear nodes (not switch/fork which manage their own routing)
		if (!['switch', 'fork', 'raise'].includes(type) && realNexts.length === 1) {
			builder.then(resolveNodeSlug(realNexts[0], nodes));
		}

		builder.sep();
	}

	return builder.build();
}
