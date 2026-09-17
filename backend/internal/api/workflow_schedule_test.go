package api

import "testing"

func TestScheduleIDForDSL(t *testing.T) {
	cases := []struct {
		name          string
		dsl           string
		wantID        string
		wantScheduled bool
	}{
		{
			name: "no schedule block",
			dsl: `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: nightly
  version: 0.1.0
do: []
`,
			wantID:        "zigflow_nightly",
			wantScheduled: false,
		},
		{
			name: "defaults to zigflow_<workflowType>",
			dsl: `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: nightly
  version: 0.1.0
schedule:
  cron: "0 0 * * *"
do: []
`,
			wantID:        "zigflow_nightly",
			wantScheduled: true,
		},
		{
			name: "explicit scheduleId wins",
			dsl: `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: nightly
  version: 0.1.0
  metadata:
    scheduleWorkflowName: nightly
    scheduleId: some-schedule
schedule:
  every:
    minutes: 3
do: []
`,
			wantID:        "some-schedule",
			wantScheduled: true,
		},
		{
			name:          "unparseable DSL is not scheduled",
			dsl:           "\tnot: yaml: at all",
			wantID:        "",
			wantScheduled: false,
		},
		{
			name: "empty schedule block declares nothing",
			dsl: `document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: nightly
  version: 0.1.0
schedule: {}
do: []
`,
			wantID:        "zigflow_nightly",
			wantScheduled: false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, scheduled := scheduleIDForDSL(c.dsl)
			if id != c.wantID || scheduled != c.wantScheduled {
				t.Errorf("scheduleIDForDSL = (%q, %v), want (%q, %v)", id, scheduled, c.wantID, c.wantScheduled)
			}
		})
	}
}
