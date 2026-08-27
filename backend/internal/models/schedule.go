package models

import "time"

type Schedule struct {
	Base
	WorkflowID string     `gorm:"not null;index" json:"workflowId"`
	Cron       string     `gorm:"not null" json:"cron"`
	Timezone   string     `gorm:"not null;default:UTC" json:"timezone"`
	Enabled    bool       `gorm:"not null;default:true" json:"enabled"`
	NextRunAt  *time.Time `json:"nextRunAt,omitempty"`
}
