import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import schema from './schema/zigflow.schema.json';

export interface FormattedError {
	/** JSON pointer path into the document, e.g. `/do/0/getUser/call`. */
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: FormattedError[];
}

let compiled: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
	if (compiled) return compiled;
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	compiled = ajv.compile(schema);
	return compiled;
}

function formatError(err: ErrorObject): FormattedError {
	const path = err.instancePath || '/';
	if (err.keyword === 'required') {
		const missing = (err.params as { missingProperty?: string }).missingProperty;
		return { path, message: `Missing required property "${missing}"` };
	}
	if (err.keyword === 'additionalProperties' || err.keyword === 'unevaluatedProperties') {
		const extra = (err.params as { additionalProperty?: string }).additionalProperty;
		return { path, message: `Unexpected property "${extra}"` };
	}
	return { path, message: err.message ?? 'Invalid value' };
}

/** Validate a plain object (already parsed from YAML/JSON) against the Zigflow DSL grammar. */
export function validateZigflowDocument(doc: unknown): ValidationResult {
	const validateFn = getValidator();
	const valid = validateFn(doc) as boolean;
	if (valid) return { valid: true, errors: [] };
	const errors = (validateFn.errors ?? []).map(formatError);
	return { valid: false, errors };
}
