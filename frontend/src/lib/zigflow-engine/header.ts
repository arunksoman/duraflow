import { parse } from 'yaml';
import type { InputField } from '../types';
import type { InputConfig } from './ast';
import { parseInputSchema } from './graph';

export interface DocumentHeader {
	taskQueue: string;
	workflowType: string;
}

/**
 * Tolerant, schema-free read of just `document.taskQueue`/`document.workflowType` out of a raw
 * DSL string — mirrors the backend's `parseDSLHeader` (backend/internal/api/executions.go). Kept
 * deliberately separate from `deserializeZigflowDocument`, which fully validates against the
 * schema: callers of this function (e.g. building the child-workflow picker from a project's
 * other workflows) need to read a sibling's header even when that sibling's DSL is blank,
 * in-progress, or otherwise invalid — it just shouldn't show up as a pickable option then.
 */
export function parseDocumentHeader(dslText: string): DocumentHeader | null {
	if (!dslText || !dslText.trim()) return null;

	let parsed: unknown;
	try {
		parsed = parse(dslText);
	} catch {
		return null;
	}

	if (typeof parsed !== 'object' || parsed === null) return null;
	const document = (parsed as Record<string, unknown>).document;
	if (typeof document !== 'object' || document === null) return null;

	const taskQueue = (document as Record<string, unknown>).taskQueue;
	const workflowType = (document as Record<string, unknown>).workflowType;
	if (typeof taskQueue !== 'string' || !taskQueue) return null;
	if (typeof workflowType !== 'string' || !workflowType) return null;

	return { taskQueue, workflowType };
}

/**
 * Reads a workflow's declared `$input` fields straight out of a stored DSL, without going through
 * the canvas. The run dialog on the executions page needs a workflow's input schema for a
 * workflow it never loaded into the builder; parsing it server-side also keeps whole DSLs off the
 * wire. Same tolerance as `parseDocumentHeader` — an unparseable DSL just declares no inputs.
 */
export function parseInputSchemaFromDsl(dslText: string): InputField[] {
	if (!dslText || !dslText.trim()) return [];

	let parsed: unknown;
	try {
		parsed = parse(dslText);
	} catch {
		return [];
	}

	if (typeof parsed !== 'object' || parsed === null) return [];
	const input = (parsed as Record<string, unknown>).input;
	if (typeof input !== 'object' || input === null) return [];

	try {
		return parseInputSchema(input as InputConfig);
	} catch {
		return [];
	}
}
