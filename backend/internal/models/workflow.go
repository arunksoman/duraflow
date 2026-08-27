package models

type Workflow struct {
	Base
	ProjectID        string  `gorm:"not null;index" json:"projectId"`
	Name             string  `gorm:"not null" json:"name"`
	Description      string  `json:"description,omitempty"`
	Version          int     `gorm:"not null;default:1" json:"version"`
	// DSL is the persisted Zigflow YAML — canonical source of truth for the workflow.
	DSL              string  `json:"dsl"`
	ParentWorkflowID *string `json:"parentWorkflowId,omitempty"`
}
