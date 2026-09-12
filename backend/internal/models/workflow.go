package models

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
}
