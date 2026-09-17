package api

import (
	"context"
	"fmt"
	"log"

	"gopkg.in/yaml.v3"
)

// A workflow's recurring trigger lives in its DSL, not in a table here: `zigflow run` reads the
// document's `schedule:` block on every worker start, deletes the Temporal schedule with the
// matching id, and recreates it only if the block is still there (pkg/zigflow/schedules.go). So
// saving a DSL is what publishes, changes or cancels a schedule, and duraflow's only job is the
// two cases zigflow can't see:
//
//   - the workflow is deleted — its worker stops, but the Temporal schedule it registered would
//     otherwise keep firing against a queue nothing polls;
//   - the schedule *id* is edited — the next worker start deletes the new id, leaving a schedule
//     under the old one running forever.
//
// Both are handled by deleting the stale schedule directly, best-effort.

// dslScheduleHeader reads the parts of a DSL that decide its Temporal schedule. Deliberately
// separate from dslDocumentHeader: that one is on the hot path of every execution start, this one
// only runs when a workflow is written or deleted.
type dslScheduleHeader struct {
	Document struct {
		WorkflowType string         `yaml:"workflowType"`
		Metadata     map[string]any `yaml:"metadata"`
	} `yaml:"document"`
	Schedule map[string]any `yaml:"schedule"`
}

// scheduleIDForDSL returns the Temporal schedule id a zigflow worker would use for this DSL, and
// whether the DSL actually declares a schedule. Mirrors zigflow's metadata.GetScheduleInfo:
// `document.metadata.scheduleId`, defaulting to `zigflow_<document.workflowType>`.
func scheduleIDForDSL(dsl string) (scheduleID string, scheduled bool) {
	var doc dslScheduleHeader
	if err := yaml.Unmarshal([]byte(dsl), &doc); err != nil {
		return "", false
	}
	if id, ok := doc.Document.Metadata["scheduleId"].(string); ok && id != "" {
		scheduleID = id
	} else if doc.Document.WorkflowType != "" {
		scheduleID = fmt.Sprintf("zigflow_%s", doc.Document.WorkflowType)
	}
	return scheduleID, scheduleID != "" && len(doc.Schedule) > 0
}

// deleteTemporalSchedule removes a schedule by id. A schedule that isn't there is the expected
// case (most workflows have none), so nothing is logged for it.
func deleteTemporalSchedule(ctx context.Context, deps *Deps, scheduleID string) {
	if scheduleID == "" {
		return
	}
	temporalClient, err := deps.Temporal.Get()
	if err != nil {
		log.Printf("[schedule] cannot reach Temporal to delete schedule %q: %v", scheduleID, err)
		return
	}
	if err := temporalClient.ScheduleClient().GetHandle(ctx, scheduleID).Delete(ctx); err != nil {
		log.Printf("[schedule] deleting schedule %q: %v", scheduleID, err)
	}
}

// dropWorkflowSchedule cancels the schedule a workflow's DSL published, if any. Called when the
// workflow is deleted.
func dropWorkflowSchedule(ctx context.Context, deps *Deps, dsl string) {
	if scheduleID, scheduled := scheduleIDForDSL(dsl); scheduled {
		deleteTemporalSchedule(ctx, deps, scheduleID)
	}
}

// dropRenamedWorkflowSchedule cancels the schedule the *previous* DSL published when a save moved
// it to a different id — the restarted worker only ever cleans up the id it is about to use.
func dropRenamedWorkflowSchedule(ctx context.Context, deps *Deps, previousDSL, nextDSL string) {
	previousID, wasScheduled := scheduleIDForDSL(previousDSL)
	if !wasScheduled {
		return
	}
	if nextID, _ := scheduleIDForDSL(nextDSL); nextID == previousID {
		return
	}
	deleteTemporalSchedule(ctx, deps, previousID)
}
