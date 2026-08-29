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

// Open connects to the database driver named in cfg and runs AutoMigrate for
// every model. This is the entire migration story for now — swapping to
// Postgres later is just database.driver: postgres + a DSN in config.yaml.
func Open(cfg config.DatabaseConfig) (*gorm.DB, error) {
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

	if err := conn.AutoMigrate(
		&models.User{},
		&models.Project{},
		&models.Workflow{},
		&models.Execution{},
		&models.Schedule{},
		&models.Worker{},
	); err != nil {
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	return conn, nil
}
