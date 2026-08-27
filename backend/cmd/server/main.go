package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"time"

	"gorm.io/gorm"

	"duraflow/backend/internal/api"
	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

const shutdownTimeout = 5 * time.Second

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	conn, err := db.Open(cfg.Database)
	if err != nil {
		log.Fatalf("database: %v", err)
	}

	if err := seedAdmin(cfg, conn); err != nil {
		log.Fatalf("seed admin: %v", err)
	}

	temporalClient := temporalexec.NewLazyClient(cfg.Temporal.Address)
	defer temporalClient.Close()

	workers := temporalexec.NewWorkerManager(cfg.Temporal.ZigflowBinary, cfg.Temporal.WorkflowsDir, cfg.Temporal.Address)
	defer workers.StopAll()
	startWorkflowWorkers(conn, workers)

	router := api.NewRouter(&api.Deps{Cfg: cfg, DB: conn, Temporal: temporalClient, Workers: workers})

	log.Printf("duraflow backend listening on %s (docs at %s/docs, api at %s)",
		cfg.Server.Addr(), cfg.Server.Addr(), cfg.Server.BasePath)

	go func() {
		if err := router.Start(cfg.Server.Addr()); err != nil {
			log.Printf("server stopped: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	<-ctx.Done()

	log.Println("shutting down — stopping workflow workers")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	_ = router.Shutdown(shutdownCtx)
}

// seedAdmin creates the configured admin user on first boot if the users
// table is empty, so there's always a way to log in against a fresh database.
func seedAdmin(cfg *config.Config, conn *gorm.DB) error {
	var count int64
	if err := conn.Model(&models.User{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	hash, err := auth.HashPassword(cfg.SeedAdmin.Password)
	if err != nil {
		return err
	}

	admin := models.User{
		Email:        cfg.SeedAdmin.Email,
		PasswordHash: hash,
		Name:         cfg.SeedAdmin.Name,
		Role:         models.RoleAdmin,
	}
	if err := conn.Create(&admin).Error; err != nil {
		return err
	}

	log.Printf("seeded admin user %s (change the password after first login)", admin.Email)
	return nil
}

// startWorkflowWorkers spawns a `zigflow run` worker for every already-stored workflow that has
// a DSL, so restarting the backend picks every workflow's execution capability back up.
func startWorkflowWorkers(conn *gorm.DB, workers *temporalexec.WorkerManager) {
	var workflows []models.Workflow
	if err := conn.Where("dsl <> ''").Find(&workflows).Error; err != nil {
		log.Printf("loading workflows for worker startup: %v", err)
		return
	}
	for _, wf := range workflows {
		workers.Sync(wf.ID, wf.Name, wf.DSL)
	}
}
