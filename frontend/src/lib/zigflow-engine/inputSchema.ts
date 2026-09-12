import type { InputField } from '../types';

/**
 * Working with a workflow's declared `$input` fields as form values: an empty starting value per
 * field, validation, and coercion of the strings an HTML form produces back into the types the
 * schema asks for. The DSL side of the same schema lives in `graph.ts`
 * (`parseInputSchema`/`stringifyInputSchema`); this is purely the value side.
 */

export function emptyValueFor(field: InputField): unknown {
	switch (field.type) {
		case 'number':
			return 0;
		case 'boolean':
			return false;
		case 'array':
			return [];
		case 'object':
			return {};
		default:
			return '';
	}
}

/** A blank value object covering every declared field, ready to bind a form to. */
export function buildInputSkeleton(fields: InputField[]): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	for (const field of fields) {
		if (!field.name) continue;
		value[field.name] = emptyValueFor(field);
	}
	return value;
}

/**
 * Checks a value object against the declared fields, returning one message per offending field.
 * Runs before a run is started so a mistyped input fails here rather than inside Temporal, where
 * it surfaces as an opaque schema-validation failure several seconds later.
 */
export function validateInput(
	fields: InputField[],
	value: Record<string, unknown>
): Record<string, string> {
	const errors: Record<string, string> = {};

	for (const field of fields) {
		if (!field.name) continue;
		const raw = value[field.name];

		if (isBlank(raw, field)) {
			if (field.required) errors[field.name] = 'Required.';
			continue;
		}

		switch (field.type) {
			case 'number':
				if (typeof raw !== 'number' || Number.isNaN(raw)) errors[field.name] = 'Must be a number.';
				break;
			case 'boolean':
				if (typeof raw !== 'boolean') errors[field.name] = 'Must be true or false.';
				break;
			case 'array':
				if (!Array.isArray(raw)) errors[field.name] = 'Must be an array.';
				else {
					const badIndex = raw.findIndex((item) => !matchesPrimitive(item, field.itemsType));
					if (badIndex >= 0) {
						errors[field.name] = `Item ${badIndex + 1} must be a ${field.itemsType ?? 'string'}.`;
					}
				}
				break;
			case 'object':
				if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
					errors[field.name] = 'Must be a JSON object.';
				}
				break;
			default:
				if (typeof raw !== 'string') errors[field.name] = 'Must be text.';
		}
	}

	return errors;
}

/**
 * Converts form-shaped values (everything arrives as a string from an `<input>`) into the declared
 * types, leaving anything it can't convert untouched so `validateInput` can report it.
 */
export function coerceInput(
	fields: InputField[],
	raw: Record<string, unknown>
): Record<string, unknown> {
	const value: Record<string, unknown> = { ...raw };

	for (const field of fields) {
		if (!field.name || !(field.name in value)) continue;
		value[field.name] = coerceValue(value[field.name], field.type, field.itemsType);
	}

	return value;
}

function coerceValue(
	raw: unknown,
	type: InputField['type'],
	itemsType: InputField['itemsType']
): unknown {
	switch (type) {
		case 'number': {
			if (typeof raw === 'number') return raw;
			if (typeof raw !== 'string' || raw.trim() === '') return raw;
			const parsed = Number(raw);
			return Number.isNaN(parsed) ? raw : parsed;
		}
		case 'boolean':
			if (typeof raw === 'boolean') return raw;
			if (raw === 'true') return true;
			if (raw === 'false') return false;
			return raw;
		case 'array':
			if (!Array.isArray(raw)) return raw;
			return raw.map((item) => coerceValue(item, itemsType ?? 'string', undefined));
		default:
			return raw;
	}
}

function matchesPrimitive(item: unknown, type: InputField['itemsType']): boolean {
	switch (type) {
		case 'number':
			return typeof item === 'number' && !Number.isNaN(item);
		case 'boolean':
			return typeof item === 'boolean';
		case 'object':
			return typeof item === 'object' && item !== null && !Array.isArray(item);
		case 'array':
			return Array.isArray(item);
		default:
			return typeof item === 'string';
	}
}

// "Blank" is per declared type: an empty list is no value for an array field, but it's a wrong
// value for an object field, and must be reported rather than skipped.
function isBlank(raw: unknown, field: InputField): boolean {
	if (raw === undefined || raw === null) return true;
	if (typeof raw === 'string') return raw.trim() === '';
	if (field.type === 'array') return Array.isArray(raw) && raw.length === 0;
	return false;
}
