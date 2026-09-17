import { describe, it, expect } from 'vitest';
import { deserializeZigflowDocument } from './deserialize';
import { serializeZigflowDocument } from './serialize';
import { astToGraph, graphToAst } from './graph';

/**
 * zigflow's own `examples/schedule/workflow.yaml`, trimmed to what this builder authors. It is the
 * reference for how the two halves of a schedule are spelled, so the canvas has to survive it
 * unchanged — a dropped `scheduleInput` or a moved `schedule:` block is a silently broken trigger.
 */
const SCHEDULE_EXAMPLE = `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: schedule
  version: 0.0.1
  title: Scheduling
  summary: Schedule the tasks to be triggered automatically
  metadata:
    scheduleWorkflowName: schedule
    scheduleId: some-schedule
    scheduleInput:
      - msg:
          - hello
          - world
        envvars: \${ $env.EXAMPLE_ENVVAR }
schedule:
  every:
    minutes: 3
  cron: "0 0 * * *"
do:
  - wait:
      wait:
        seconds: 5
`;

function roundTrip(yamlText: string): string {
	const parsed = deserializeZigflowDocument(yamlText);
	if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
	const { graph, header } = astToGraph(parsed.document);
	return serializeZigflowDocument(graphToAst(graph, header));
}

describe('schedule round trip', () => {
	it('validates against the vendored schema', () => {
		expect(deserializeZigflowDocument(SCHEDULE_EXAMPLE).ok).toBe(true);
	});

	it('keeps the schedule block and its metadata through canvas <-> DSL', () => {
		const out = roundTrip(SCHEDULE_EXAMPLE);
		const reparsed = deserializeZigflowDocument(out);
		expect(reparsed.ok).toBe(true);
		if (!reparsed.ok) return;

		expect(reparsed.document.schedule).toEqual({ every: { minutes: 3 }, cron: '0 0 * * *' });
		expect(reparsed.document.document.metadata).toEqual({
			scheduleWorkflowName: 'schedule',
			scheduleId: 'some-schedule',
			scheduleInput: [{ msg: ['hello', 'world'], envvars: '${ $env.EXAMPLE_ENVVAR }' }]
		});
	});

	it('is stable — a second round trip changes nothing', () => {
		const once = roundTrip(SCHEDULE_EXAMPLE);
		expect(roundTrip(once)).toBe(once);
	});

	it('accepts the parked configuration a switched-off schedule leaves in metadata', () => {
		// `document.metadata` allows extra keys, but that has to hold for a *nested* object too or
		// turning a schedule off would produce a DSL the builder then refuses to load.
		const parked = `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: nightly
  version: 0.1.0
  metadata:
    duraflow:
      disabledSchedule:
        useCron: true
        useInterval: false
        cron: "30 4 * * 1"
do:
  - wait:
      wait:
        seconds: 5
`;
		const result = deserializeZigflowDocument(parked);
		expect(result.ok).toBe(true);
		expect(roundTrip(parked)).toContain('disabledSchedule');
	});

	it('leaves an unscheduled document without any schedule keys', () => {
		const plain = `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: plain
  version: 0.1.0
do:
  - wait:
      wait:
        seconds: 5
`;
		const out = roundTrip(plain);
		expect(out).not.toContain('schedule');
		expect(out).not.toContain('duraflow');
	});
});
