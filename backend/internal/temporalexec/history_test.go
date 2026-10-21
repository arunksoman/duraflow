package temporalexec

import (
	"testing"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/converter"

	"duraflow/backend/internal/models"
)

func payload(t *testing.T, v any) *commonpb.Payload {
	t.Helper()
	p, err := converter.GetDefaultDataConverter().ToPayload(v)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func payloads(t *testing.T, vs ...any) *commonpb.Payloads {
	t.Helper()
	out := &commonpb.Payloads{}
	for _, v := range vs {
		out.Payloads = append(out.Payloads, payload(t, v))
	}
	return out
}

func taskMeta(name string) map[string]any {
	return map[string]any{"data": map[string]any{"task": map[string]any{"name": name}}}
}

func TestExtractTaskName(t *testing.T) {
	cases := []struct {
		name     string
		summary  *commonpb.Payload
		payloads *commonpb.Payloads
		want     string
		wantOK   bool
	}{
		{"summary wins", payload(t, "fromSummary"), payloads(t, taskMeta("fromPayload")), "fromSummary", true},
		{"empty summary falls back to payloads", payload(t, ""), payloads(t, taskMeta("fromPayload")), "fromPayload", true},
		{"meta payload found at any position", nil, payloads(t, "plain", 42, taskMeta("third")), "third", true},
		{"no meta anywhere", nil, payloads(t, "plain", map[string]any{"data": 1}), "", false},
		{"nothing at all", nil, nil, "", false},
		{"non-string summary ignored", payload(t, 7), nil, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ExtractTaskName(c.summary, c.payloads)
			if got != c.want || ok != c.wantOK {
				t.Errorf("ExtractTaskName = (%q, %v), want (%q, %v)", got, ok, c.want, c.wantOK)
			}
		})
	}
}

func TestMapWorkflowStatus(t *testing.T) {
	cases := map[enumspb.WorkflowExecutionStatus]models.ExecutionStatus{
		enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:        models.ExecutionCompleted,
		enumspb.WORKFLOW_EXECUTION_STATUS_FAILED:           models.ExecutionFailed,
		enumspb.WORKFLOW_EXECUTION_STATUS_CANCELED:         models.ExecutionCancelled,
		enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED:       models.ExecutionTerminated,
		enumspb.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:        models.ExecutionTimedOut,
		enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING:          models.ExecutionRunning,
		enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW: models.ExecutionRunning,
		enumspb.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED:      models.ExecutionRunning,
	}
	for in, want := range cases {
		if got := MapWorkflowStatus(in); got != want {
			t.Errorf("MapWorkflowStatus(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestEventTypeIsWorkflowClose(t *testing.T) {
	closing := []enumspb.EventType{
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
	}
	for _, et := range closing {
		if !EventTypeIsWorkflowClose(&historypb.HistoryEvent{EventType: et}) {
			t.Errorf("%v should close the workflow", et)
		}
	}
	for _, et := range []enumspb.EventType{
		enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
	} {
		if EventTypeIsWorkflowClose(&historypb.HistoryEvent{EventType: et}) {
			t.Errorf("%v should not close the workflow", et)
		}
	}
	if EventTypeIsWorkflowClose(nil) {
		t.Error("nil event should not close the workflow")
	}
}
