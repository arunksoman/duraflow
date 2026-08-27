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

	// WorkflowName is computed via join at query time, never stored.
	WorkflowName string `gorm:"-" json:"workflowName"`
}
