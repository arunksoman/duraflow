package models

import (
	"time"

	"gorm.io/datatypes"
)

type ExecutionStatus string

const (
	ExecutionRunning    ExecutionStatus = "running"
	ExecutionCompleted  ExecutionStatus = "completed"
	ExecutionFailed     ExecutionStatus = "failed"
	ExecutionCancelled  ExecutionStatus = "cancelled"
	ExecutionTerminated ExecutionStatus = "terminated"
	ExecutionTimedOut   ExecutionStatus = "timed_out"
)

type Execution struct {
	Base
	WorkflowID        string          `gorm:"not null;index" json:"workflowId"`
	Status            ExecutionStatus `gorm:"not null;default:running" json:"status"`
	StartedAt         time.Time       `json:"startedAt"`
	CompletedAt       *time.Time      `json:"completedAt,omitempty"`
	Input             datatypes.JSON  `json:"input,omitempty"`
	Output            datatypes.JSON  `json:"output,omitempty"`
	ParentExecutionID *string         `json:"parentExecutionId,omitempty"`
	TemporalRunID     string          `json:"temporalRunId,omitempty"`

	// Error is the failure message Temporal reports once a non-completed workflow closes — the
	// single most important thing to show after a run, and previously not stored at all.
	Error string `json:"error,omitempty"`
	// WorkflowType is only set for child executions whose Temporal workflow type matched no
	// stored Workflow, so the UI still has something to label the run with.
	WorkflowType string `json:"workflowType,omitempty"`
	// RootExecutionID is the top-most ancestor of a child-workflow chain (itself, for a root run).
	RootExecutionID string `gorm:"index" json:"rootExecutionId,omitempty"`
	// ParentTaskName/ParentScopePath locate this child run on the parent's canvas, so the
	// originating `childWorkflow` node can link straight to it.
	ParentTaskName  string `json:"parentTaskName,omitempty"`
	ParentScopePath string `json:"parentScopePath,omitempty"`

	// WorkflowName is computed via join at query time, never stored.
	WorkflowName string `gorm:"-" json:"workflowName"`
}
