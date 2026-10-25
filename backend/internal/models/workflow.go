package models

import "time"

type Workflow struct {
	Base
	ProjectID   string `gorm:"not null;index" json:"projectId"`
	Name        string `gorm:"not null" json:"name"`
	Description string `json:"description,omitempty"`
	Version     int    `gorm:"not null;default:1" json:"version"`
	// DSL is the persisted Zigflow YAML — canonical source of truth for the workflow.
	DSL              string  `json:"dsl"`
	ParentWorkflowID *string `json:"parentWorkflowId,omitempty"`

	// WorkflowType/TaskQueue are denormalized from the DSL's `document` header on every write,
	// so resolving "which workflow is this Temporal child workflow?" is an indexed lookup rather
	// than a YAML parse of every stored DSL.
	WorkflowType string `gorm:"index" json:"workflowType,omitempty"`
	TaskQueue    string `gorm:"index" json:"taskQueue,omitempty"`

	// CurrentHash names the DSLVersion new runs of this workflow start on: the SHA-256 of the
	// DSL, set on every save whose DSL builds. Empty when the DSL is blank or does not build,
	// in which case the workflow cannot be run and DSLError says why.
	CurrentHash string `gorm:"index" json:"currentHash,omitempty"`
	// DSLError is zigflow's reason for rejecting the saved DSL, shown when a run is refused.
	DSLError string `json:"dslError,omitempty"`
}

// DSLVersion is one immutable, content-addressed DSL text. Runs carry the hash in a Temporal
// header, and any worker in the pool loads and builds the version from this table on demand, so a
// run keeps executing the DSL it started with even after later saves. Rows are never updated.
type DSLVersion struct {
	Hash         string    `gorm:"primaryKey" json:"hash"`
	DSL          string    `gorm:"not null" json:"dsl"`
	TaskQueue    string    `json:"taskQueue"`
	WorkflowType string    `json:"workflowType"`
	CreatedAt    time.Time `json:"createdAt"`
}

// WorkflowRegistration records every Temporal workflow name a workflow's current DSL registers on
// its task queue: the document's own workflowType plus each `do` list zigflow runs as a child
// workflow. The worker pool uses it to find the DSL for a run that arrives without a hash header
// (runs started before this table existed, or by an external client), and to pin a
// `run: workflow` child to the current version of the workflow it targets.
type WorkflowRegistration struct {
	TaskQueue  string `gorm:"primaryKey"`
	Name       string `gorm:"primaryKey"`
	WorkflowID string `gorm:"primaryKey;index"`
}
