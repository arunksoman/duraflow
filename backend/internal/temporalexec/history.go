package temporalexec

import (
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/converter"

	"duraflow/backend/internal/models"
)

// What happened inside a run comes from zigflow's CloudEvents (see internal/api/telemetry.go),
// not from Temporal history: `set` and `switch` leave no correlatable history events at all, and
// `for`/`fork`/`try` bodies execute as separate child workflows whose activities never appear in
// the parent's history. Temporal is still the authority on three things, which is all that lives
// here: an execution's terminal status, and — via ExtractTaskName — which DSL task started a
// given child workflow.

// taskMetaPayload mirrors the JSON shape zigflow embeds in every side-effecting task's
// Activity/ChildWorkflow input payloads — whichever payload in the list is shaped like this
// carries `data.task.name`, the real DSL task name, regardless of the payload's position
// (activities carry 3 input payloads, child-workflow-initiated events carry 2).
type taskMetaPayload struct {
	Data struct {
		Task struct {
			Name string `json:"name"`
		} `json:"task"`
	} `json:"data"`
}

// ExtractTaskName recovers the DSL task name from an event's UserMetadata.Summary (zigflow sets
// ActivityOptions.Summary to the task name on every task) or, failing that, by scanning the given
// input payloads for one shaped like taskMetaPayload. Child-workflow events carry no summary, so
// the payload scan is the path that matters for them.
func ExtractTaskName(summary *commonpb.Payload, payloads *commonpb.Payloads) (string, bool) {
	dc := converter.GetDefaultDataConverter()

	if summary != nil {
		var name string
		if err := dc.FromPayload(summary, &name); err == nil && name != "" {
			return name, true
		}
	}

	for _, p := range payloads.GetPayloads() {
		var meta taskMetaPayload
		if err := dc.FromPayload(p, &meta); err == nil && meta.Data.Task.Name != "" {
			return meta.Data.Task.Name, true
		}
	}

	return "", false
}

// MapWorkflowStatus converts a Temporal workflow close status into this app's Execution status
// enum. WORKFLOW_EXECUTION_STATUS_RUNNING, CONTINUED_AS_NEW (a zigflow workflow with
// `canMaxHistoryLength` rolls over mid-run — describe the latest run, not the first) and PAUSED
// fall through to ExecutionRunning — the caller should only act on this once it already knows the
// workflow is closed.
func MapWorkflowStatus(status enumspb.WorkflowExecutionStatus) models.ExecutionStatus {
	switch status {
	case enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:
		return models.ExecutionCompleted
	case enumspb.WORKFLOW_EXECUTION_STATUS_FAILED:
		return models.ExecutionFailed
	case enumspb.WORKFLOW_EXECUTION_STATUS_CANCELED:
		return models.ExecutionCancelled
	case enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED:
		return models.ExecutionTerminated
	case enumspb.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
		return models.ExecutionTimedOut
	default:
		return models.ExecutionRunning
	}
}

// EventTypeIsWorkflowClose reports whether ev marks the terminal close of the whole workflow
// execution (as opposed to a single task's completion/failure).
func EventTypeIsWorkflowClose(ev *historypb.HistoryEvent) bool {
	switch ev.GetEventType() {
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED,
		enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED:
		return true
	}
	return false
}
