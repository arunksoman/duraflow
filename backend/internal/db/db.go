// Package db opens the GORM connection and runs auto-migration.
package db

import (
	"fmt"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"duraflow/backend/internal/config"
	"duraflow/backend/internal/models"
)

// Open connects and migrates in one step. Tests and single-process tools use it; the server
// connects and migrates separately so that, on Postgres, only one copy migrates at a time.
func Open(cfg config.DatabaseConfig) (*gorm.DB, error) {
	conn, err := Connect(cfg)
	if err != nil {
		return nil, err
	}
	if err := Migrate(conn); err != nil {
		return nil, err
	}
	return conn, nil
}

// Connect opens the database named in cfg without touching its schema.
func Connect(cfg config.DatabaseConfig) (*gorm.DB, error) {
	var dialector gorm.Dialector
	switch cfg.Driver {
	case "postgres":
		dialector = postgres.Open(cfg.DSN)
	case "sqlite", "":
		dialector = sqlite.Open(cfg.DSN)
	default:
		return nil, fmt.Errorf("unsupported database driver %q", cfg.Driver)
	}

	conn, err := gorm.Open(dialector, &gorm.Config{})
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	return conn, nil
}

// Migrate runs AutoMigrate for every model. This is the entire migration story: adding a field to
// a model is enough for GORM to add the column.
func Migrate(conn *gorm.DB) error {
	if err := conn.AutoMigrate(
		&models.User{},
		&models.Project{},
		&models.Workflow{},
		&models.Execution{},
		&models.Worker{},
		&models.ExecutionEvent{},
		&models.WorkflowExecutionRef{},
		&models.DSLVersion{},
		&models.WorkflowRegistration{},
	); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}
