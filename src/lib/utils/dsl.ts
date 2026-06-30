import type { Node, Edge } from '@xyflow/svelte';

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
		case 'call':
		case 'task':
			out += `      call: http\n`;
			out += `      with:\n`;
			out += `        method: ${data.method ?? 'get'}\n`;
			out += `        endpoint: ${data.endpoint ?? 'https://api.example.com/endpoint'}\n`;
			if (type === 'task' && data.timeout) out += `        timeout: ${data.timeout}\n`;
			break;
		case 'do':
			out += `      do:\n`;
			out += `        - step: {}\n`;
			break;
		case 'for':
			out += `      for:\n`;
			out += `        each: ${data.each ?? 'item'}\n`;
			out += `        in: \${.${data.collection ?? 'items'}}\n`;
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
		case 'switch':
			out += `      switch:\n`;
			if (nexts.length >= 2) {
				out += `        - when: \${.condition == "true"}\n`;
				out += `          then: ${resolveLabel(nexts[0])}\n`;
				out += `        - else:\n`;
				out += `            then: ${resolveLabel(nexts[1])}\n`;
			} else if (nexts.length === 1) {
				out += `        - when: \${.condition == "true"}\n`;
				out += `          then: ${resolveLabel(nexts[0])}\n`;
				out += `        - else:\n`;
				out += `            then: end\n`;
			} else {
				out += `        - when: \${.condition == "true"}\n`;
				out += `          then: continue\n`;
				out += `        - else:\n`;
				out += `            then: end\n`;
			}
			break;
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
		case 'set':
			out += `      set:\n`;
			out += `        ${data.variable ?? 'result'}: \${.${data.value ?? 'output'}}\n`;
			break;
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
		case 'run':
			out += `      run:\n`;
			out += `        task:\n`;
			out += `          name: ${data.taskName ?? 'my-task'}\n`;
			break;
		case 'childWorkflow':
			out += `      run:\n`;
			out += `        workflow:\n`;
			out += `          name: ${data.workflowName ?? 'child-workflow'}\n`;
			out += `          version: '0.1.0'\n`;
			break;
		default:
			out += `      # Unknown type: ${type}\n`;
	}

	if (nexts.length === 1 && !['fork', 'switch'].includes(type)) {
		out += `      then: ${resolveLabel(nexts[0])}\n`;
	}

	return out;
}

export function generateDsl(nodes: Node[], edges: Edge[]): string {
	if (nodes.length === 0) {
		return [
			"# Add nodes to the canvas to generate DSL",
			"# Drag from the left palette or click '+' on any type",
			"",
			"document:",
			"  dsl: '1.0.0-alpha5'",
			"  namespace: default",
			"  name: my-workflow",
			"  version: '0.1.0'",
			"",
			"do: []"
		].join('\n');
	}

	const nextMap = new Map<string, string[]>();
	const prevSet = new Set<string>();

	for (const edge of edges) {
		if (!nextMap.has(edge.source)) nextMap.set(edge.source, []);
		nextMap.get(edge.source)!.push(edge.target);
		prevSet.add(edge.target);
	}

	const visited = new Set<string>();
	const ordered: Node[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		visited.add(id);
		const node = nodes.find((n) => n.id === id);
		if (node) ordered.push(node);
		for (const nxt of nextMap.get(id) ?? []) visit(nxt);
	}

	for (const node of nodes) {
		if (!prevSet.has(node.id)) visit(node.id);
	}
	for (const node of nodes) visit(node.id);

	const name = toKebab((ordered[0]?.data?.label as string) ?? 'my-workflow');

	let out = `document:\n`;
	out += `  dsl: '1.0.0-alpha5'\n`;
	out += `  namespace: default\n`;
	out += `  name: ${name}\n`;
	out += `  version: '0.1.0'\n\n`;
	out += `do:\n`;

	for (const node of ordered) {
		out += taskToYaml(node, nextMap, nodes);
		out += '\n';
	}

	return out;
}
