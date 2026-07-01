import type { Node, Edge } from '@xyflow/svelte';

type VarEntry = { key: string; value: string };
type CaseEntry = { name: string; condition: string; then: string };

function toKebab(str: string): string {
	return (
		str
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

function taskToYaml(node: Node, nextMap: Map<string, string[]>, allNodes: Node[]): string {
	const data = node.data as Record<string, unknown>;
	const type = (node.type ?? 'task') as string;
	const label = (data.label as string) ?? type;
	const id = toKebab(label);
	const nexts = nextMap.get(node.id) ?? [];

	const resolveLabel = (nid: string) =>
		toKebab((allNodes.find((n) => n.id === nid)?.data.label as string) ?? nid);

	let out = `  - ${id}:\n`;

	switch (type) {
		case 'call': {
			const hdrs = ((data.headers as VarEntry[]) ?? []).filter((h) => h.key);
			const qry = ((data.query as VarEntry[]) ?? []).filter((q) => q.key);
			const bodyStr = ((data.body as string) ?? '').trim();
			const outputFmt = (data.output as string) ?? 'content';
			const redir = data.redirect === true;

			out += `      call: http\n`;
			out += `      with:\n`;
			out += `        method: ${data.method ?? 'get'}\n`;
			out += `        endpoint: ${data.endpoint ?? ''}\n`;

			if (hdrs.length > 0) {
				out += `        headers:\n`;
				for (const h of hdrs) out += `          ${h.key}: ${h.value}\n`;
			}

			if (qry.length > 0) {
				out += `        query:\n`;
				for (const q of qry) out += `          ${q.key}: ${q.value}\n`;
			}

			if (bodyStr) {
				const lines = bodyStr.split('\n');
				if (lines.length === 1) {
					out += `        body: ${lines[0]}\n`;
				} else {
					out += `        body: |\n`;
					for (const line of lines) out += `          ${line}\n`;
				}
			}

			if (outputFmt !== 'content') out += `        output: ${outputFmt}\n`;
			if (redir) out += `        redirect: true\n`;
			break;
		}

		case 'task':
			out += `      call: http\n`;
			out += `      with:\n`;
			out += `        method: ${data.method ?? 'get'}\n`;
			out += `        endpoint: ${data.endpoint ?? 'https://api.example.com/endpoint'}\n`;
			if (data.timeout) out += `        timeout: ${data.timeout}\n`;
			break;

		case 'do':
			out += `      do:\n`;
			out += `        - step: {}\n`;
			break;

		case 'for':
			out += `      for:\n`;
			out += `        each: ${data.each ?? 'item'}\n`;
			out += `        in: \${ .${data.collection ?? 'items'} }\n`;
			out += `        do:\n`;
			out += `          - step: {}\n`;
			break;

		case 'fork':
			out += `      fork:\n`;
			out += `        compete: false\n`;
			out += `        branches:\n`;
			if (nexts.length > 0) {
				for (const nid of nexts) out += `          - ${resolveLabel(nid)}: {}\n`;
			} else {
				out += `          - branch1: {}\n`;
				out += `          - branch2: {}\n`;
			}
			break;

		case 'switch': {
			const cases = (data.cases as CaseEntry[]) ?? [];
			out += `      switch:\n`;
			if (cases.length > 0) {
				for (const c of cases) {
					out += `        - ${c.name}:\n`;
					if (c.condition) out += `            when: ${c.condition}\n`;
					out += `            then: ${c.then || 'continue'}\n`;
				}
			} else {
				out += `        - default:\n`;
				out += `            then: end\n`;
			}
			break;
		}

		case 'try':
			out += `      try:\n`;
			out += `        do:\n`;
			out += `          - step: {}\n`;
			out += `      catch:\n`;
			out += `        errors:\n`;
			out += `          as: error\n`;
			out += `        do:\n`;
			out += `          - handleError: {}\n`;
			break;

		case 'set': {
			const vars = (data.variables as VarEntry[]) ?? [];
			out += `      set:\n`;
			if (vars.length > 0) {
				for (const v of vars) {
					if (v.key) out += `        ${v.key}: ${v.value || "''"}\n`;
				}
			} else {
				out += `        result: \${ . }\n`;
			}
			break;
		}

		case 'wait':
			out += `      wait:\n`;
			out += `        seconds: ${data.duration ?? 30}\n`;
			break;

		case 'listen':
			out += `      listen:\n`;
			out += `        to:\n`;
			out += `          - type: ${data.eventType ?? 'custom.event'}\n`;
			break;

		case 'raise':
			out += `      raise:\n`;
			out += `        event:\n`;
			out += `          type: ${data.eventType ?? 'custom.event'}\n`;
			out += `          source: duraflow\n`;
			break;

		case 'run': {
			const runType = (data.runType as string) ?? 'script';
			out += `      run:\n`;
			if (runType === 'script') {
				out += `        script:\n`;
				out += `          language: ${(data.language as string) ?? 'js'}\n`;
				out += `          code: |\n`;
				const lines = ((data.code as string) ?? '').split('\n');
				for (const line of lines) out += `            ${line}\n`;
			} else if (runType === 'shell') {
				out += `        shell:\n`;
				out += `          command: ${(data.command as string) || 'echo hello'}\n`;
			} else if (runType === 'container') {
				out += `        container:\n`;
				out += `          image: ${(data.image as string) || 'alpine:latest'}\n`;
				out += `          pullPolicy: ${(data.pullPolicy as string) || 'ifNotPresent'}\n`;
			} else if (runType === 'workflow') {
				out += `        workflow:\n`;
				out += `          type: ${(data.workflowType as string) || 'my-workflow-type'}\n`;
				out += `          input: \${ . }\n`;
				out += `          await: true\n`;
			}
			break;
		}

		case 'childWorkflow':
			out += `      run:\n`;
			out += `        workflow:\n`;
			out += `          type: ${(data.workflowType as string) || 'child-workflow-type'}\n`;
			out += `          input: \${ . }\n`;
			out += `          await: true\n`;
			break;

		default:
			out += `      # Unknown node type: ${type}\n`;
	}

	if (nexts.length === 1 && !['fork', 'switch'].includes(type)) {
		out += `      then: ${resolveLabel(nexts[0])}\n`;
	}

	return out;
}

export function generateDsl(nodes: Node[], edges: Edge[]): string {
	if (nodes.length === 0) {
		return [
			'# Add nodes to the canvas to generate DSL',
			'# Drag from the right palette or click a node type',
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
	const prevSet = new Set<string>();

	for (const edge of edges) {
		if (!nextMap.has(edge.source)) nextMap.set(edge.source, []);
		nextMap.get(edge.source)!.push(edge.target);
		prevSet.add(edge.target);
	}

	const skipTypes = new Set(['start', 'end']);
	const visited = new Set<string>();
	const ordered: Node[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		visited.add(id);
		const node = nodes.find((n) => n.id === id);
		if (node && !skipTypes.has(node.type ?? '')) ordered.push(node);
		for (const nxt of nextMap.get(id) ?? []) visit(nxt);
	}

	for (const node of nodes) {
		if (!prevSet.has(node.id)) visit(node.id);
	}
	for (const node of nodes) visit(node.id);

	const workflowName = toKebab((ordered[0]?.data?.label as string) ?? 'my-workflow');

	let out = `document:\n`;
	out += `  dsl: '1.0.0-alpha5'\n`;
	out += `  namespace: default\n`;
	out += `  name: ${workflowName}\n`;
	out += `  version: '0.1.0'\n\n`;
	out += `do:\n`;

	// If the start node has variables, emit an init set task first
	const startNode = nodes.find((n) => n.type === 'start');
	const startVars = (startNode?.data?.variables as VarEntry[]) ?? [];
	const validStartVars = startVars.filter((v) => v.key);

	if (validStartVars.length > 0) {
		out += `  - init:\n`;
		out += `      set:\n`;
		for (const v of validStartVars) {
			out += `        ${v.key}: ${v.value || "''"}\n`;
		}
		out += '\n';
	}

	for (const node of ordered) {
		out += taskToYaml(node, nextMap, nodes);
		out += '\n';
	}

	return out;
}
