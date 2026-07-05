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

	raw(...items: string[]): this {
		this.lines.push(...items);
		return this;
	}

	// ── Document header ──────────────────────────────────────────────

	document(meta: WorkflowMeta, workflowName: string): this {
		this.push(
			`document:`,
			`  dsl: 1.0.0`,
			`  taskQueue: ${meta.taskQueue || 'zigflow'}`,
			`  workflowType: ${meta.workflowType || workflowName}`,
			`  version: '${meta.version || '0.0.1'}'`
		);
		this.push('', 'do:');
		return this;
	}

	// ── Data flow (input.from / output.as / export.as) ───────────────

	private dataFlow(data: Record<string, unknown>, indent: string): this {
		const inputFrom = ((data.inputFrom as string) ?? '').trim();
		const outputAs = ((data.outputAs as string) ?? '').trim();
		const exportAs = ((data.exportAs as string) ?? '').trim();

		if (inputFrom) {
			this.push(`${indent}input:`);
			this.push(`${indent}  from: ${inputFrom}`);
		}
		if (outputAs) {
			this.push(`${indent}output:`);
			this.push(`${indent}  as: ${outputAs}`);
		}
		if (exportAs) {
			this.push(`${indent}export:`);
			this.push(`${indent}  as: ${exportAs}`);
		}
		return this;
	}

	// ── Task emitters ────────────────────────────────────────────────

	call(taskId: string, data: Record<string, unknown>): this {
		const hdrs = ((data.headers as VarEntry[]) ?? []).filter((h) => h.key);
		const qry = ((data.query as VarEntry[]) ?? []).filter((q) => q.key);
		const bodyStr = ((data.body as string) ?? '').trim();
		const outputFmt = (data.output as string) ?? 'content';
		const redir = data.redirect === true;

		this.push(`  - ${taskId}:`);
		this.push(`      call: http`);
		this.dataFlow(data, '      ');
		this.push(`      with:`);
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

		return this;
	}

	task(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`);
		this.push(`      call: http`);
		this.dataFlow(data, '      ');
		this.push(`      with:`);
		this.push(`        method: ${data.method ?? 'get'}`);
		this.push(`        endpoint: ${data.endpoint ?? ''}`);
		if (data.timeout) this.push(`        timeout: ${data.timeout}`);
		return this;
	}

	set(taskId: string, data: Record<string, unknown>): this {
		const vars = (data.variables as VarEntry[]) ?? [];
		const valid = vars.filter((v) => v.key);
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      set:`);
		if (valid.length > 0) {
			for (const v of valid) this.push(`        ${v.key}: ${v.value || "''"}`);
		} else {
			this.push('        result: ${ . }');
		}
		return this;
	}

	if(taskId: string, data: Record<string, unknown>): this {
		const condition = ((data.condition as string) ?? '').trim();
		const vars = (data.variables as VarEntry[]) ?? [];
		const valid = vars.filter((v) => v.key);
		this.push(`  - ${taskId}:`);
		if (condition) this.push(`      if: ${condition}`);
		this.dataFlow(data, '      ');
		this.push(`      set:`);
		if (valid.length > 0) {
			for (const v of valid) this.push(`        ${v.key}: ${v.value || "''"}`);
		} else {
			this.push('        result: ${ . }');
		}
		return this;
	}

	switch(taskId: string, data: Record<string, unknown>, allNodes: Node[]): this {
		const cases = (data.cases as CaseEntry[]) ?? [];
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      switch:`);
		for (const c of cases) {
			this.push(`        - ${c.name}:`);
			if (c.condition.trim()) this.push(`            when: ${c.condition.trim()}`);
			this.push(`            then: ${resolveThen(c.then, allNodes)}`);
		}
		return this;
	}

	for(taskId: string, data: Record<string, unknown>): this {
		const each = (data.each as string) || 'item';
		const at = (data.at as string) || 'index';
		const inExpr = (data.in as string) || '${ $input.items }';
		const whileExpr = ((data.while as string) ?? '').trim();

		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      for:`);
		this.push(`        each: ${each}`);
		this.push(`        at: ${at}`);
		this.push(`        in: ${inExpr}`);
		if (whileExpr) this.push(`        while: ${whileExpr}`);
		this.push(`        do:`);
		this.push('          - step:');
		this.push('              set:');
		this.push('                result: ${ . }');
		return this;
	}

	fork(taskId: string, data: Record<string, unknown>, nexts: string[], allNodes: Node[]): this {
		const compete = data.compete === true;
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      fork:`);
		if (compete) this.push(`        compete: true`);
		this.push(`        branches:`);
		if (nexts.length > 0) {
			for (const nid of nexts) {
				const slug = resolveNodeSlug(nid, allNodes);
				this.push(`          - ${slug}:`);
				this.push(`              do: []`);
			}
		} else {
			this.push(`          - branch1:`);
			this.push(`              do: []`);
			this.push(`          - branch2:`);
			this.push(`              do: []`);
		}
		return this;
	}

	try(taskId: string, data: Record<string, unknown>): this {
		const catchAs = (data.catchAs as string) || 'error';
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push('      try:');
		this.push('        - tryBody:');
		this.push('            set:');
		this.push('              result: ${ . }');
		this.push(`      catch:`);
		this.push(`        as: ${catchAs}`);
		this.push(`        do:`);
		this.push('          - handleError:');
		this.push('              set:');
		this.push(`                error: \${ $data.${catchAs} }`);
		return this;
	}

	wait(taskId: string, data: Record<string, unknown>): this {
		const mode = (data.waitMode as string) ?? 'duration';
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      wait:`);
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
		return this;
	}

	listen(taskId: string, data: Record<string, unknown>): this {
		const strategy = (data.strategy as string) || 'one';
		const events = (data.events as EventEntry[]) ?? [];
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      listen:`);
		this.push(`        to:`);
		this.push(`          ${strategy}:`);
		if (events.length > 0) {
			for (const ev of events) {
				this.push(`            - with:`);
				this.push(`                id: ${ev.id}`);
				this.push(`                type: ${ev.type}`);
				if (ev.data) this.push(`                data: ${ev.data}`);
				if (ev.acceptIf) this.push(`                acceptIf: ${ev.acceptIf}`);
			}
		} else {
			this.push(`            - with:`);
			this.push(`                id: my-event`);
			this.push(`                type: signal`);
		}
		return this;
	}

	raise(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`);
		this.push(`      raise:`);
		this.push(`        error:`);
		this.push(`          type: ${data.errorType ?? 'https://serverlessworkflow.io/spec/1.0.0/errors/communication'}`);
		this.push(`          status: ${data.errorStatus ?? 500}`);
		if (data.errorTitle) this.push(`          title: ${data.errorTitle}`);
		if (data.errorDetail) this.push(`          detail: ${data.errorDetail}`);
		return this;
	}

	run(taskId: string, data: Record<string, unknown>): this {
		const runType = (data.runType as string) ?? 'script';
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      run:`);

		if (runType === 'script') {
			const lang = (data.language as string) ?? 'js';
			const code = (data.code as string) ?? '';
			this.push(`        script:`);
			this.push(`          language: ${lang}`);
			this.push(`          code: |`);
			for (const l of code.split('\n')) this.push(`            ${l}`);
		} else if (runType === 'shell') {
			this.push(`        shell:`);
			this.push(`          command: ${(data.command as string) || 'echo hello'}`);
		} else if (runType === 'container') {
			this.push(`        container:`);
			this.push(`          image: ${(data.image as string) || 'alpine:latest'}`);
			this.push(`          pullPolicy: ${(data.pullPolicy as string) || 'ifNotPresent'}`);
		} else if (runType === 'workflow') {
			this.push(`        workflow:`);
			this.push(`          type: ${(data.workflowType as string) || 'my-workflow-type'}`);
		}
		return this;
	}

	childWorkflow(taskId: string, data: Record<string, unknown>): this {
		const input = ((data.childInput as string) || '').trim();
		const awaitChild = data.await !== false;
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push(`      run:`);
		this.push(`        workflow:`);
		this.push(`          type: ${(data.workflowType as string) || 'child-workflow-type'}`);
		if (input && input !== '${ . }') this.push(`          input: ${input}`);
		if (!awaitChild) this.push(`          await: false`);
		return this;
	}

	do(taskId: string, data: Record<string, unknown>): this {
		this.push(`  - ${taskId}:`);
		this.dataFlow(data, '      ');
		this.push('      do:');
		this.push('        - step:');
		this.push('            set:');
		this.push('              result: ${ . }');
		return this;
	}

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

	for (const node of nodes) {
		if (!prevSet.has(node.id)) visit(node.id);
	}
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
			'  dsl: 1.0.0',
			'  taskQueue: zigflow',
			'  workflowType: my-workflow',
			"  version: '0.0.1'",
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
	const workflowName = toSlug((meta?.workflowType) || ((ordered[0]?.data?.label as string) ?? 'my-workflow'));

	const effectiveMeta: WorkflowMeta = meta ?? {
		workflowType: workflowName,
		taskQueue: 'zigflow',
		namespace: '',
		version: '0.0.1',
		inputSchema: [],
		envVars: []
	};

	const builder = new DslBuilder();
	builder.document(effectiveMeta, workflowName);

	// Emit init set block if Start node has variables
	const startNode = nodes.find((n) => n.type === 'start');
	const startVars = ((startNode?.data?.variables as VarEntry[]) ?? []).filter((v) => v.key);
	if (startVars.length > 0) {
		builder.raw(`  - init:`);
		builder.raw(`      set:`);
		for (const v of startVars) builder.raw(`        ${v.key}: ${v.value || "''"}`);
		builder.sep();
	}

	for (let i = 0; i < ordered.length; i++) {
		const node = ordered[i];
		const data = (node.data ?? {}) as Record<string, unknown>;
		const type = node.type ?? 'task';
		const taskId = toSlug((data.label as string) ?? type);
		const nexts = nextMap.get(node.id) ?? [];

		switch (type) {
			case 'call':
				builder.call(taskId, data);
				break;
			case 'task':
				builder.task(taskId, data);
				break;
			case 'set':
				builder.set(taskId, data);
				break;
			case 'if':
				builder.if(taskId, data);
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

		builder.sep();
	}

	return builder.build();
}
