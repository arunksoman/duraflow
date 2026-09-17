<script lang="ts">
	import cronstrue from 'cronstrue';
	import { CronExpressionParser } from 'cron-parser';
	import {
		WEEKDAY_LABELS,
		buildCronPreset,
		isValidCronExpression,
		joinCron,
		parseCronPreset,
		splitCron,
		type CronFields,
		type CronPreset
	} from '$lib/zigflow-engine/cron';

	interface Props {
		value: string;
		onchange: (expression: string) => void;
	}

	let { value, onchange }: Props = $props();

	/**
	 * The expression is the single source of truth: the controls below are *derived* from it, so
	 * typing a cron by hand redraws them and clicking a control rewrites the cron. The one piece of
	 * local state is "the user asked for the raw five-field editor even though this expression is
	 * something the visual controls could draw".
	 */
	let forcedCustom = $state(false);

	const preset = $derived<CronPreset>(forcedCustom ? { kind: 'custom' } : parseCronPreset(value));
	const fields = $derived<CronFields>(
		splitCron(value) ?? { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' }
	);
	const valid = $derived(isValidCronExpression(value));

	const description = $derived.by(() => {
		if (!valid) return null;
		try {
			return cronstrue.toString(value, { verbose: false, throwExceptionOnParseError: true });
		} catch {
			return null;
		}
	});

	/**
	 * Temporal evaluates a schedule's cron in UTC, so the preview must be rendered in UTC too —
	 * showing the viewer's local time here would be a different instant from the one that fires.
	 */
	const nextRuns = $derived.by(() => {
		if (!valid) return [];
		try {
			const iterator = CronExpressionParser.parse(value, { tz: 'UTC' });
			return Array.from({ length: 3 }, () => iterator.next().toDate());
		} catch {
			return [];
		}
	});

	const PRESET_OPTIONS: { kind: CronPreset['kind']; label: string }[] = [
		{ kind: 'everyMinute', label: 'Every minute' },
		{ kind: 'everyNMinutes', label: 'Every N minutes' },
		{ kind: 'everyNHours', label: 'Every N hours' },
		{ kind: 'hourly', label: 'Hourly' },
		{ kind: 'daily', label: 'Daily' },
		{ kind: 'weekly', label: 'Weekly' },
		{ kind: 'monthly', label: 'Monthly' },
		{ kind: 'custom', label: 'Custom (raw fields)' }
	];

	/** `HH:MM` for `<input type="time">`, which is how hour+minute are edited for the timed presets. */
	function timeValue(hour: number, minute: number): string {
		return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	}

	function parseTime(raw: string): { hour: number; minute: number } | null {
		const match = /^(\d{1,2}):(\d{2})/.exec(raw);
		if (!match) return null;
		const hour = Number(match[1]);
		const minute = Number(match[2]);
		if (hour > 23 || minute > 59) return null;
		return { hour, minute };
	}

	function emit(next: CronPreset) {
		onchange(buildCronPreset(next));
	}

	function selectPreset(kind: CronPreset['kind']) {
		forcedCustom = kind === 'custom';
		if (kind === 'custom') return;

		// Carry whatever the current expression already says across the switch, so changing
		// "daily at 09:30" to "weekly" keeps 09:30 instead of resetting to midnight.
		const current = preset;
		const hour = 'hour' in current ? current.hour : 9;
		const minute = 'minute' in current && typeof current.minute === 'number' ? current.minute : 0;
		switch (kind) {
			case 'everyMinute':
				return emit({ kind });
			case 'everyNMinutes':
				return emit({ kind, minutes: 15 });
			case 'everyNHours':
				return emit({ kind, hours: 6, minute });
			case 'hourly':
				return emit({ kind, minute });
			case 'daily':
				return emit({ kind, hour, minute });
			case 'weekly':
				return emit({ kind, weekdays: [1], hour, minute });
			case 'monthly':
				return emit({ kind, dayOfMonth: 1, hour, minute });
		}
	}

	function setTime(raw: string) {
		const time = parseTime(raw);
		if (!time || preset.kind === 'custom') return;
		if (preset.kind === 'daily' || preset.kind === 'weekly' || preset.kind === 'monthly') {
			emit({ ...preset, ...time });
		}
	}

	function toggleWeekday(day: number) {
		if (preset.kind !== 'weekly') return;
		const weekdays = preset.weekdays.includes(day)
			? preset.weekdays.filter((d) => d !== day)
			: [...preset.weekdays, day];
		// A weekly schedule with no days selected has no cron spelling — keep the last day on.
		if (weekdays.length === 0) return;
		emit({ ...preset, weekdays });
	}

	function setField(key: keyof CronFields, raw: string) {
		onchange(joinCron({ ...fields, [key]: raw.trim() || '*' }));
	}

	const RAW_FIELDS: { key: keyof CronFields; label: string; hint: string }[] = [
		{ key: 'minute', label: 'Minute', hint: '0–59' },
		{ key: 'hour', label: 'Hour', hint: '0–23' },
		{ key: 'dayOfMonth', label: 'Day of month', hint: '1–31' },
		{ key: 'month', label: 'Month', hint: '1–12' },
		{ key: 'dayOfWeek', label: 'Day of week', hint: '0–6, Sun=0' }
	];
</script>

<div class="flex flex-col gap-3">
	<!-- Visual builder -->
	<div class="flex flex-wrap items-end gap-2">
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-[11px] font-medium">Repeats</span>
			<select
				class="select select-sm w-44"
				value={preset.kind}
				onchange={(e) => selectPreset((e.target as HTMLSelectElement).value as CronPreset['kind'])}
			>
				{#each PRESET_OPTIONS as option (option.kind)}
					<option value={option.kind}>{option.label}</option>
				{/each}
			</select>
		</label>

		{#if preset.kind === 'everyNMinutes'}
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">Minutes</span>
				<input
					type="number"
					min="1"
					max="59"
					class="input input-sm w-24"
					value={preset.minutes}
					onchange={(e) => {
						const minutes = Number((e.target as HTMLInputElement).value);
						if (minutes >= 1 && minutes <= 59) emit({ kind: 'everyNMinutes', minutes });
					}}
				/>
			</label>
		{:else if preset.kind === 'everyNHours'}
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">Hours</span>
				<input
					type="number"
					min="1"
					max="23"
					class="input input-sm w-24"
					value={preset.hours}
					onchange={(e) => {
						const hours = Number((e.target as HTMLInputElement).value);
						if (hours >= 1 && hours <= 23) {
							emit({
								kind: 'everyNHours',
								hours,
								minute: preset.kind === 'everyNHours' ? preset.minute : 0
							});
						}
					}}
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">At minute</span>
				<input
					type="number"
					min="0"
					max="59"
					class="input input-sm w-24"
					value={preset.minute}
					onchange={(e) => {
						const minute = Number((e.target as HTMLInputElement).value);
						if (minute >= 0 && minute <= 59 && preset.kind === 'everyNHours') {
							emit({ ...preset, minute });
						}
					}}
				/>
			</label>
		{:else if preset.kind === 'hourly'}
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">At minute</span>
				<input
					type="number"
					min="0"
					max="59"
					class="input input-sm w-24"
					value={preset.minute}
					onchange={(e) => {
						const minute = Number((e.target as HTMLInputElement).value);
						if (minute >= 0 && minute <= 59) emit({ kind: 'hourly', minute });
					}}
				/>
			</label>
		{:else if preset.kind === 'monthly'}
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">Day of month</span>
				<input
					type="number"
					min="1"
					max="31"
					class="input input-sm w-24"
					value={preset.dayOfMonth}
					onchange={(e) => {
						const dayOfMonth = Number((e.target as HTMLInputElement).value);
						if (dayOfMonth >= 1 && dayOfMonth <= 31 && preset.kind === 'monthly') {
							emit({ ...preset, dayOfMonth });
						}
					}}
				/>
			</label>
		{/if}

		{#if preset.kind === 'daily' || preset.kind === 'weekly' || preset.kind === 'monthly'}
			<label class="flex flex-col gap-1">
				<span class="text-base-content/60 text-[11px] font-medium">At (UTC)</span>
				<input
					type="time"
					class="input input-sm w-32"
					value={timeValue(preset.hour, preset.minute)}
					onchange={(e) => setTime((e.target as HTMLInputElement).value)}
				/>
			</label>
		{/if}
	</div>

	{#if preset.kind === 'weekly'}
		<div class="flex flex-wrap gap-1">
			{#each WEEKDAY_LABELS as label, day (label)}
				<button
					type="button"
					class="btn btn-xs"
					class:btn-primary={preset.weekdays.includes(day)}
					onclick={() => toggleWeekday(day)}
					aria-pressed={preset.weekdays.includes(day)}
				>
					{label}
				</button>
			{/each}
		</div>
	{/if}

	{#if preset.kind === 'custom'}
		<div class="grid grid-cols-5 gap-2">
			{#each RAW_FIELDS as field (field.key)}
				<label class="flex flex-col gap-1">
					<span class="text-base-content/60 text-[11px] font-medium">{field.label}</span>
					<input
						class="input input-sm w-full font-mono"
						value={fields[field.key]}
						onchange={(e) => setField(field.key, (e.target as HTMLInputElement).value)}
					/>
					<span class="text-base-content/35 text-[10px]">{field.hint}</span>
				</label>
			{/each}
		</div>
	{/if}

	<!-- The expression itself, always editable — typing here redraws the controls above -->
	<label class="flex flex-col gap-1">
		<span class="text-base-content/60 text-[11px] font-medium">Cron expression</span>
		<input
			class="input input-sm w-full font-mono"
			class:input-error={!valid}
			{value}
			placeholder="0 0 * * *"
			spellcheck="false"
			oninput={(e) => onchange((e.target as HTMLInputElement).value)}
		/>
	</label>

	{#if !valid}
		<p class="text-error text-xs">
			Not a valid 5-field cron expression (minute hour day-of-month month day-of-week).
		</p>
	{:else}
		<div class="bg-base-200 flex flex-col gap-1 rounded-lg px-3 py-2">
			<p class="text-sm font-medium">{description ?? 'Valid expression'}</p>
			{#if nextRuns.length > 0}
				<p class="text-base-content/50 text-[11px]">
					Next: {nextRuns.map((d) => d.toISOString().replace('T', ' ').slice(0, 16)).join(' · ')} UTC
				</p>
			{/if}
		</div>
	{/if}
</div>
