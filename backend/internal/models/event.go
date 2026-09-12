package models

import (
	"time"

	"gorm.io/datatypes"
)

// Event types, as received from zigflow with the `dev.zigflow.` prefix stripped. These are the
// only ones stored; anything else a future zigflow version emits is ignored at ingest.
const (
	EventWorkflowStarted   = "workflow.started"
	EventWorkflowCompleted = "workflow.completed"
	EventTaskStarted       = "task.started"
	EventTaskRetried       = "task.retried"
	EventTaskCancelled     = "task.cancelled"
	EventTaskFaulted       = "task.faulted"
	EventTaskCompleted     = "task.completed"
	EventIterationComplete = "iteration.completed"
)

// ExecutionEvent is one CloudEvent emitted by a `zigflow run` worker while a workflow executes —
// the record of what actually happened, task by task, that the UI replays to highlight canvas
// nodes and show each node's input/output. Temporal history can't serve this role: `set` and
// `switch` leave no correlatable history events at all, and zigflow runs `for`/`fork`/`try`
// bodies as separate child workflows whose activities never appear in the parent's history.
//
// Rows are append-only and ordered by Seq (receive order), never by OccurredAt — zigflow
// re-stamps the CloudEvent time on every workflow replay.
type ExecutionEvent struct {
	Seq uint64 `gorm:"primaryKey;autoIncrement" json:"seq"`

	// ExecutionID is the nearest owning Execution row, which for events from a `run: workflow`
	// child is the child's own row, not the root's. Empty until the resolver has walked this
	// event's Temporal parent chain (see temporalexec.Resolver).
	ExecutionID     string `gorm:"index:idx_event_exec,priority:1" json:"executionId"`
	RootExecutionID string `gorm:"index" json:"rootExecutionId"`
	// WorkflowExecutionID is the raw CloudEvent `id`: the Temporal workflow execution the event
	// came from. For a nested scope that's a synthetic child like "<parent>_for_0".
	WorkflowExecutionID string `gorm:"index;not null" json:"workflowExecutionId"`
	// ScopePath locates the event within the owning execution's canvas: "" for the root scope,
	// otherwise the child-workflow id suffixes joined by "_" — "for_0", "try", "fork_worker-a",
	// "for_0_try". The frontend maps this onto its scope tree; the backend never interprets it.
	ScopePath string `json:"scopePath,omitempty"`

	EventType  string    `gorm:"not null" json:"eventType"`
	TaskName   string    `gorm:"index" json:"taskName,omitempty"`
	Attempt    int       `json:"attempt,omitempty"`
	OccurredAt time.Time `json:"occurredAt"`
	ReceivedAt time.Time `json:"receivedAt"`

	// Data is the CloudEvent payload: {attempt,input,state} for task.started,
	// {input,output,state} for task.completed, {error} for task.faulted, and so on.
	Data      datatypes.JSON `json:"data,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`

	// DedupeKey collapses the copies zigflow re-emits on every workflow replay — its emission is
	// not replay-guarded. See api.dedupeKeyFor for what goes into it and the one case it
	// deliberately over-collapses.
	DedupeKey string `gorm:"uniqueIndex;not null" json:"-"`
}

// WorkflowExecutionRef caches the resolution of one Temporal workflow execution id to the
// Execution row that owns it, so the parent-chain walk (a Temporal RPC per level) happens at
// most once per id for the life of the database.
type WorkflowExecutionRef struct {
	WorkflowExecutionID string    `gorm:"primaryKey" json:"workflowExecutionId"`
	TemporalRunID       string    `gorm:"index" json:"temporalRunId,omitempty"`
	ExecutionID         string    `gorm:"index;not null" json:"executionId"`
	RootExecutionID     string    `gorm:"index;not null" json:"rootExecutionId"`
	ScopePath           string    `json:"scopePath,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
}
