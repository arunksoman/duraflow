/**
 * The structured model behind the builder's expression fields — a lossless round-trip between a
 * Zigflow runtime expression (`${ jq }`) and a list of tokens the UI renders as chips.
 *
 * A value is one of two shapes, chosen by the field that owns it (`ExprMode`):
 * - `template`: the stored string is either plain text or a whole `${ ... }` runtime expression
 *   (task arguments, headers, `set` values, `output.as`, ...).
 * - `jq`: the stored string is bare jq with no `${ }` wrapper (one operand of a condition).
 *
 * Parsing never fails: anything this model cannot represent structurally becomes a `raw` token
 * holding the jq text verbatim, and serializing tokens that came from a parse reproduces an
 * expression with the same meaning. That is what keeps hand-written DSL intact when a node's panel
 * is edited.
 */

export type VarSource = 'input' | 'data' | 'context' | 'output' | 'env' | 'dot';

/** A path segment — an object key, or an array index. */
export type PathSegment = string | number;

export interface VarToken {
	kind: 'var';
	source: VarSource;
	path: PathSegment[];
	/** jq filters piped after the reference, in order, without the leading `|`. */
	transforms: string[];
}

export interface LiteralToken {
	kind: 'literal';
	text: string;
}

export interface RawToken {
	kind: 'raw';
	expr: string;
}

export type ExprToken = VarToken | LiteralToken | RawToken;

export type ExprMode = 'template' | 'jq';

export const VAR_SOURCES: VarSource[] = ['input', 'data', 'context', 'output', 'env', 'dot'];

/** One-letter badge per source, as shown on a variable chip. */
export const SOURCE_LETTER: Record<VarSource, string> = {
	input: 'I',
	data: 'D',
	context: 'C',
	output: 'O',
	env: 'E',
	dot: '.'
};

export const SOURCE_LABEL: Record<VarSource, string> = {
	input: 'Input',
	data: 'Data',
	context: 'Context',
	output: 'Output',
	env: 'Environment',
	dot: 'Current value'
};

/** Common jq filters offered after `|`. Function-style entries insert with their parentheses. */
export const TRANSFORMS: { name: string; hint: string }[] = [
	{ name: 'tostring', hint: 'to string' },
	{ name: 'tonumber', hint: 'to number' },
	{ name: 'length', hint: 'length / size' },
	{ name: 'ascii_downcase', hint: 'lowercase' },
	{ name: 'ascii_upcase', hint: 'uppercase' },
	{ name: 'keys', hint: 'object keys' },
	{ name: 'values', hint: 'non-null values' },
	{ name: 'first', hint: 'first element' },
	{ name: 'last', hint: 'last element' },
	{ name: 'reverse', hint: 'reverse' },
	{ name: 'sort', hint: 'sort array' },
	{ name: 'unique', hint: 'deduplicate' },
	{ name: 'flatten', hint: 'flatten arrays' },
	{ name: 'add', hint: 'sum / concat' },
	{ name: 'min', hint: 'minimum' },
	{ name: 'max', hint: 'maximum' },
	{ name: 'floor', hint: 'round down' },
	{ name: 'ceil', hint: 'round up' },
	{ name: 'round', hint: 'round' },
	{ name: 'abs', hint: 'absolute value' },
	{ name: 'not', hint: 'boolean negation' },
	{ name: 'type', hint: 'value type' },
	{ name: 'tojson', hint: 'encode JSON' },
	{ name: 'fromjson', hint: 'decode JSON' },
	{ name: '@base64', hint: 'base64 encode' },
	{ name: '@base64d', hint: 'base64 decode' },
	{ name: '@uri', hint: 'URL encode' },
	{ name: 'split(",")', hint: 'split string' },
	{ name: 'join(",")', hint: 'join array' },
	{ name: 'select(. != null)', hint: 'drop nulls' },
	{ name: 'map(tostring)', hint: 'map each element' },
	{ name: 'test("regex")', hint: 'regex match' }
];

// ── Low-level scanning ─────────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Splits `src` on every top-level occurrence of `sep` (outside strings and brackets). Returns
 * `null` when brackets or strings are unbalanced — the caller then treats the text as opaque.
 * `sep` is matched literally; for `|` a following `=` (the `|=` operator) is not a separator, and
 * for `+` neither is `+=`.
 */
export function splitTopLevel(src: string, sep: '+' | '|' | ','): string[] | null {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"') {
			const end = skipString(src, i);
			if (end < 0) return null;
			i = end;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			continue;
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth < 0) return null;
			continue;
		}
		if (depth === 0 && ch === sep) {
			if ((sep === '|' || sep === '+') && src[i + 1] === '=') continue;
			parts.push(src.slice(start, i));
			start = i + 1;
		}
	}
	if (depth !== 0) return null;
	parts.push(src.slice(start));
	return parts;
}

/** Index of the closing quote of the jq string literal opening at `i`, or -1 if unterminated. */
function skipString(src: string, i: number): number {
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === '\\') {
			j++;
			continue;
		}
		if (src[j] === '"') return j;
	}
	return -1;
}

/** `(x)` → `x` when the outer parentheses wrap the whole text; otherwise `null`. */
export function stripOuterParens(src: string): string | null {
	const t = src.trim();
	if (!t.startsWith('(') || !t.endsWith(')')) return null;
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (ch === '"') {
			const end = skipString(t, i);
			if (end < 0) return null;
			i = end;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0 && i !== t.length - 1) return null;
		}
	}
	return depth === 0 ? t.slice(1, -1).trim() : null;
}

// ── References ─────────────────────────────────────────────────────────────

function sourceFromName(name: string): VarSource | null {
	return (VAR_SOURCES as string[]).includes(name) && name !== 'dot' ? (name as VarSource) : null;
}

/**
 * Parses a path suffix — `.a.b[0]."odd key"["x"]` — into segments. `allowBareDot` accepts a lone
 * `.` (the jq identity, only meaningful for the `dot` source). Returns `null` for anything else.
 */
function parsePathSuffix(s: string, allowBareDot: boolean): PathSegment[] | null {
	const path: PathSegment[] = [];
	let i = 0;
	if (s === '.' && allowBareDot) return path;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '.') {
			i++;
			if (i >= s.length) return null;
			if (s[i] === '[') continue;
			if (s[i] === '"') {
				const end = skipString(s, i);
				if (end < 0) return null;
				try {
					path.push(JSON.parse(s.slice(i, end + 1)) as string);
				} catch {
					return null;
				}
				i = end + 1;
				continue;
			}
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
			if (!m) return null;
			path.push(m[0]);
			i += m[0].length;
			continue;
		}
		if (ch === '[') {
			const close = s.indexOf(']', i);
			if (close < 0) return null;
			const inner = s.slice(i + 1, close).trim();
			if (/^\d+$/.test(inner)) path.push(Number(inner));
			else if (/^"(?:[^"\\]|\\.)*"$/.test(inner)) {
				try {
					path.push(JSON.parse(inner) as string);
				} catch {
					return null;
				}
			} else return null;
			i = close + 1;
			continue;
		}
		return null;
	}
	return path;
}

/** Parses a bare reference — `$data.user.name`, `.items[0]`, `.` — or returns `null`. */
export function parseRef(text: string): { source: VarSource; path: PathSegment[] } | null {
	const t = text.trim();
	if (t.startsWith('$')) {
		const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
		if (!m) return null;
		const source = sourceFromName(m[1]);
		if (!source) return null;
		const path = parsePathSuffix(t.slice(m[0].length), false);
		return path ? { source, path } : null;
	}
	if (t.startsWith('.')) {
		const path = parsePathSuffix(t, true);
		return path ? { source: 'dot', path } : null;
	}
	return null;
}

export function pathSuffix(path: PathSegment[]): string {
	return path
		.map((seg) =>
			typeof seg === 'number'
				? `[${seg}]`
				: IDENT_RE.test(seg)
					? `.${seg}`
					: `[${JSON.stringify(seg)}]`
		)
		.join('');
}

/** The jq text of a reference: `$data.user["first-name"]`, `.items[0]`, `.`. */
export function refToJq(source: VarSource, path: PathSegment[]): string {
	const suffix = pathSuffix(path);
	if (source !== 'dot') return `$${source}${suffix}`;
	if (!suffix) return '.';
	return suffix.startsWith('.') ? suffix : `.${suffix}`;
}

/** Human form of a path for chips and path inputs: `user.name[0]`. */
export function pathToText(path: PathSegment[]): string {
	const suffix = pathSuffix(path);
	return suffix.startsWith('.') ? suffix.slice(1) : suffix;
}

/** Inverse of `pathToText`; `null` when the text is not a valid path. Empty text is the root. */
export function parsePathText(text: string): PathSegment[] | null {
	const t = text.trim();
	if (!t) return [];
	return parsePathSuffix(t.startsWith('[') || t.startsWith('.') ? t : `.${t}`, false);
}

/** A transform is one pipe stage we can show on a chip: a name, a format, or a function call. */
function isSimpleTransform(t: string): boolean {
	const s = t.trim();
	if (!s) return false;
	if (/^@[A-Za-z0-9_]+$/.test(s)) return true;
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
		return ![
			'and',
			'or',
			'if',
			'then',
			'else',
			'end',
			'as',
			'reduce',
			'foreach',
			'def',
			'try',
			'catch'
		].includes(s);
	const call = /^[A-Za-z_][A-Za-z0-9_]*\(([\s\S]*)\)$/.exec(s);
	return !!call && stripOuterParens(s.slice(s.indexOf('('))) !== null;
}

/** Splits `a | b | c` into stages, or `null` when the text has no parseable pipe structure. */
export function parseTransforms(text: string): string[] | null {
	const t = text.trim();
	if (!t) return [];
	const stages = splitTopLevel(t, '|');
	if (!stages) return null;
	const out = stages.map((s) => s.trim());
	return out.every(isSimpleTransform) ? out : null;
}

// ── Tokens ─────────────────────────────────────────────────────────────────

function parseVarWithTransforms(text: string): VarToken | null {
	const stages = splitTopLevel(text, '|');
	if (!stages) return null;
	const ref = parseRef(stages[0]);
	if (!ref) return null;
	const transforms = stages.slice(1).map((s) => s.trim());
	if (!transforms.every(isSimpleTransform)) return null;
	return { kind: 'var', source: ref.source, path: ref.path, transforms };
}

function parseStringLiteral(text: string): string | null {
	const t = text.trim();
	if (!/^"(?:[^"\\]|\\.)*"$/s.test(t)) return null;
	try {
		return JSON.parse(t) as string;
	} catch {
		// jq string interpolation (`"\(x)"`) is not JSON — keep it as raw jq.
		return null;
	}
}

/** Parses one operand of a jq `+` chain. `multi` tells whether it sits inside a longer chain. */
function parsePiece(piece: string, multi: boolean): ExprToken | null {
	const t = piece.trim();
	if (!t) return null;
	const str = parseStringLiteral(t);
	if (str !== null) return { kind: 'literal', text: str };
	const inner = stripOuterParens(t);
	if (inner !== null) {
		const v = parseVarWithTransforms(inner);
		if (v) return v;
		return multi ? { kind: 'raw', expr: inner } : null;
	}
	const v = parseVarWithTransforms(t);
	if (v && (!multi || v.transforms.length === 0)) return v;
	return null;
}

/** Parses bare jq into tokens. Never fails — unrepresentable jq becomes one `raw` token. */
function parseJq(jq: string): ExprToken[] {
	const inner = jq.trim();
	if (!inner) return [];
	const pieces = splitTopLevel(inner, '+');
	if (!pieces) return [{ kind: 'raw', expr: inner }];
	if (pieces.length === 1) {
		return [parsePiece(inner, false) ?? { kind: 'raw', expr: inner }];
	}
	// A top-level `|` binds looser than `+`, so the chain is not the outermost operation.
	if ((splitTopLevel(inner, '|') ?? []).length > 1) return [{ kind: 'raw', expr: inner }];
	const tokens: ExprToken[] = [];
	for (const p of pieces) {
		const tok = parsePiece(p, true);
		if (!tok) return [{ kind: 'raw', expr: inner }];
		tokens.push(tok);
	}
	return tokens;
}

const TEMPLATE_RE = /^\s*\$\{([\s\S]*)\}\s*$/;

/** Parses a stored field value into tokens. */
export function parseExpression(value: string, mode: ExprMode = 'template'): ExprToken[] {
	if (!value) return [];
	if (mode === 'jq') return parseJq(value);
	const m = TEMPLATE_RE.exec(value);
	// Plain text — or text that merely contains `${ }` pieces, which is not one runtime expression.
	if (!m || !m[1].trim() || splitTopLevel(m[1], '+') === null)
		return [{ kind: 'literal', text: value }];
	return parseJq(m[1]);
}

function pieceToJq(tok: ExprToken, multi: boolean): string {
	switch (tok.kind) {
		case 'literal':
			return JSON.stringify(tok.text);
		case 'raw':
			return multi ? `(${tok.expr})` : tok.expr;
		case 'var': {
			const base = [refToJq(tok.source, tok.path), ...tok.transforms].join(' | ');
			return multi && tok.transforms.length > 0 ? `(${base})` : base;
		}
	}
}

/** The jq text of a token list, with no `${ }` wrapper. */
export function tokensToJq(tokens: ExprToken[]): string {
	const multi = tokens.length > 1;
	return tokens.map((t) => pieceToJq(t, multi)).join(' + ');
}

/** Serializes tokens back into a stored field value. */
export function serializeExpression(tokens: ExprToken[], mode: ExprMode = 'template'): string {
	const live = tokens.filter((t) => !(t.kind === 'raw' && !t.expr.trim()));
	if (live.length === 0) return '';
	if (mode === 'template' && live.length === 1 && live[0].kind === 'literal') return live[0].text;
	const jq = tokensToJq(live);
	return mode === 'jq' ? jq : `\${ ${jq} }`;
}

/** Strips a `${ }` wrapper if present — for fields that store bare jq. */
export function unwrapTemplate(value: string): string {
	const m = TEMPLATE_RE.exec(value);
	return m ? m[1].trim() : value.trim();
}
