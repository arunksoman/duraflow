<script lang="ts">
	// Test-only: hosts WorkflowInputForm with a bound value and reports every change to it.
	import WorkflowInputForm from '$lib/components/execution/WorkflowInputForm.svelte';
	import type { InputField } from '$lib/types';

	interface Props {
		fields: InputField[];
		initial?: Record<string, unknown>;
		errors?: Record<string, string>;
		onvalue: (value: Record<string, unknown>) => void;
		onjsonerror?: (message: string | null) => void;
	}

	let { fields, initial = {}, errors, onvalue, onjsonerror }: Props = $props();

	// svelte-ignore state_referenced_locally
	let value = $state<Record<string, unknown>>(initial);

	$effect(() => {
		onvalue($state.snapshot(value));
	});
</script>

<WorkflowInputForm {fields} {errors} {onjsonerror} bind:value />
