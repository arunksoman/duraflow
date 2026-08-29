package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Base gives every table a UUID primary key and timestamps, matching the
// camelCase shape the frontend's TS domain types (src/lib/types/index.ts) expect.
type Base struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (b *Base) BeforeCreate(_ *gorm.DB) error {
	if b.ID == "" {
		b.ID = uuid.NewString()
	}
	return nil
}
