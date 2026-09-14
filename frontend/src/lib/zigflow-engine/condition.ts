/**
 * The structured model behind the builder's condition fields (`if`, `switch` case `when`, `for`
 * `while`, `listen` `acceptIf`): a flat chain of clauses joined by `and`/`or`, round-tripped to a
 * `${ jq }` runtime expression.
 *
 * Like `expression.ts`, parsing never fails — a clause with no recognised operator is kept as a
 * "is truthy" clause over its verbatim jq, so hand-written conditions survive being edited.
 */

import { splitTopLevel, stripOuterParens, unwrapTemplate } from './expression';

export type ConditionOp =
	| '=='
	| '!='
	| '>'
	| '>='
	| '<'
	| '<='
	| 'contains'
	| 'startswith'
	| 'endswith'
	| 'test'
	| 'truthy'
	| 'falsy';

export type RightKind = 'string' | 'number' | 'bool' | 'null' | 'expr';

export interface ConditionRight {
	kind: RightKind;
	/** Unquoted text for `string`; the literal for `number`/`bool`; bare jq for `expr`. */
	value: string;
}

export interface ConditionClause {
	/** Bare jq for the left operand. */
	left: string;
	op: ConditionOp;
	right: ConditionRight;
	/** How this clause joins the NEXT one; ignored on the last clause. */
	join: 'and' | 'or';
}

export const COMPARISON_OPS: ConditionOp[] = ['==', '!=', '>', '>=', '<', '<='];
export const FUNCTION_OPS: ConditionOp[] = ['contains', 'startswith', 'endswith', 'test'];
export const UNARY_OPS: ConditionOp[] = ['truthy', 'falsy'];

export const OP_LABEL: Record<ConditionOp, string> = {
	'==': '= equals',
	'!=': '≠ not equal',
	'>': '> greater',
	'>=': '≥ at least',
	'<': '< less',
	'<=': '≤ at most',
	contains: 'contains',
	startswith: 'starts with',
	endswith: 'ends with',
	test: 'matches regex',
	truthy: 'is true / set',
	falsy: 'is false / empty'
};

export function isUnary(op: ConditionOp): boolean {
	return UNARY_OPS.includes(op);
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Splits on top-level `and` / `or` keywords (outside strings and brackets). */
function splitLogical(src: string): { part: string; join: 'and' | 'or' }[] | null {
	const out: { part: string; join: 'and' | 'or' }[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"') {
			let j = i + 1;
			for (; j < src.length; j++) {
				if (src[j] === '\\') j++;
				else if (src[j] === '"') break;
			}
			if (j >= src.length) return null;
			i = j;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		if (depth < 0) return null;
		if (depth !== 0 || !/\s/.test(ch)) continue;
		const m = /^\s+(and|or)\s+/.exec(src.slice(i));
		if (m) {
			out.push({ part: src.slice(start, i), join: m[1] as 'and' | 'or' });
			i += m[0].length - 1;
			start = i + 1;
		}
	}
	if (depth !== 0) return null;
	out.push({ part: src.slice(start), join: 'and' });
	return out;
}

/** Finds the first top-level comparison operator: `[index, operator]`. */
function findComparison(src: string): [number, ConditionOp] | null {
	let depth = 0;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		if (depth !== 0) continue;
		const two = src.slice(i, i + 2);
		if (two === '==' || two === '!=' || two === '>=' || two === '<=') return [i, two];
		// `|=`, `//=` etc. are assignments, never comparisons.
		if ((ch === '>' || ch === '<') && src[i - 1] !== '|') return [i, ch];
	}
	return null;
}

export function parseRight(raw: string): ConditionRight {
	const t = raw.trim();
	if (t === 'null') return { kind: 'null', value: '' };
	if (t === 'true' || t === 'false') return { kind: 'bool', value: t };
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return { kind: 'number', value: t };
	if (/^"(?:[^"\\]|\\.)*"$/s.test(t)) {
		try {
			return { kind: 'string', value: JSON.parse(t) as string };
		} catch {
			// String interpolation — keep as jq.
		}
	}
	return { kind: 'expr', value: t };
}

function parseClause(part: string): Omit<ConditionClause, 'join'> {
	const text = part.trim();
	const inner = stripOuterParens(text) ?? text;

	// `left | not`, `left | contains("x")` — possibly wrapped in parentheses.
	const stages = splitTopLevel(inner, '|');
	if (stages && stages.length > 1) {
		const last = stages[stages.length - 1].trim();
		const left = stages.slice(0, -1).join('|').trim();
		if (last === 'not') return { left, op: 'falsy', right: { kind: 'null', value: '' } };
		const fn = /^(contains|startswith|endswith|test)\(([\s\S]*)\)$/.exec(last);
		if (fn && stripOuterParens(last.slice(fn[1].length)) !== null) {
			return { left, op: fn[1] as ConditionOp, right: parseRight(fn[2]) };
		}
	}

	const cmp = findComparison(text);
	if (cmp) {
		const [idx, op] = cmp;
		const leftRaw = text.slice(0, idx).trim();
		const rightRaw = text.slice(idx + op.length).trim();
		if (leftRaw && rightRaw)
			return { left: unwrapPipedOperand(leftRaw), op, right: parseRight(rightRaw) };
	}

	return { left: unwrapPipedOperand(text), op: 'truthy', right: { kind: 'null', value: '' } };
}

function hasTopLevelPipe(src: string): boolean {
	return (splitTopLevel(src, '|')?.length ?? 1) > 1;
}

/** The serializer parenthesizes a piped operand — undo that so the field shows `$x | length`. */
function unwrapPipedOperand(src: string): string {
	const inner = stripOuterParens(src);
	return inner !== null && hasTopLevelPipe(inner) ? inner : src.trim();
}

/** Parses a stored condition (with or without `${ }`) into clauses. Empty input → `[]`. */
export function parseCondition(value: string): ConditionClause[] {
	const jq = unwrapTemplate(value ?? '');
	if (!jq) return [];
	const parts = splitLogical(jq);
	if (!parts) return [{ left: jq, op: 'truthy', right: { kind: 'null', value: '' }, join: 'and' }];
	return parts.map(({ part, join }) => ({ ...parseClause(part), join }));
}

// ── Serialization ──────────────────────────────────────────────────────────

export function rightToJq(right: ConditionRight): string {
	switch (right.kind) {
		case 'string':
			return JSON.stringify(right.value);
		case 'number':
			return right.value.trim() || '0';
		case 'bool':
			return right.value === 'false' ? 'false' : 'true';
		case 'null':
			return 'null';
		case 'expr':
			return right.value.trim();
	}
}

/** Whether a clause has enough filled in to emit. Incomplete clauses stay in the UI only. */
export function isClauseComplete(c: ConditionClause): boolean {
	if (!c.left.trim()) return false;
	if (isUnary(c.op)) return true;
	return c.right.kind !== 'expr' || !!c.right.value.trim();
}

function operandToJq(left: string): string {
	const t = left.trim();
	return hasTopLevelPipe(t) ? `(${t})` : t;
}

export function clauseToJq(c: ConditionClause): string {
	const left = c.left.trim();
	switch (c.op) {
		case 'truthy':
			return operandToJq(left);
		case 'falsy':
			return `(${left} | not)`;
		case 'contains':
		case 'startswith':
		case 'endswith':
		case 'test':
			return `(${left} | ${c.op}(${rightToJq(c.right)}))`;
		default:
			return `${operandToJq(left)} ${c.op} ${rightToJq(c.right)}`;
	}
}

/** Serializes clauses into a `${ }` runtime expression; `''` when nothing is complete. */
export function serializeCondition(clauses: ConditionClause[]): string {
	const live = clauses.filter(isClauseComplete);
	if (live.length === 0) return '';
	let out = clauseToJq(live[0]);
	for (let i = 1; i < live.length; i++) out += ` ${live[i - 1].join} ${clauseToJq(live[i])}`;
	return `\${ ${out} }`;
}
