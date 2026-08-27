package models

type Project struct {
	Base
	Name        string `gorm:"not null" json:"name"`
	Description string `json:"description,omitempty"`

	// WorkflowCount is computed at query time (see api/projects.go), never stored.
	WorkflowCount int `gorm:"-" json:"workflowCount"`
}
