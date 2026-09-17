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
	"duraflow/backend/internal/events"
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

	workers := temporalexec.NewWorkerManager(cfg.Temporal, cfg.Telemetry)
	defer workers.StopAll()

	bus := events.NewBroker()
	resolver := temporalexec.NewResolver(conn, temporalClient, bus, cfg.Telemetry.RetentionPerExecution)

	deps := &api.Deps{
		Cfg:      cfg,
		DB:       conn,
		Temporal: temporalClient,
		Workers:  workers,
		Bus:      bus,
		Resolver: resolver,
	}

	// A child workflow — or a run Temporal started from a workflow's own schedule — only becomes
	// visible once its first event arrives, so this is where its completion watcher gets started.
	resolver.OnExecutionDiscovered = func(execution models.Execution) {
		go api.WatchExecutionUntilClosed(deps, execution.ID)
	}

	resolverCtx, stopResolver := context.WithCancel(context.Background())
	defer stopResolver()
	go resolver.Run(resolverCtx)

	backfillWorkflowHeaders(conn)
	startWorkflowWorkers(conn, workers)
	resumeRunningExecutions(conn, deps)

	router := api.NewRouter(deps)

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

// backfillWorkflowHeaders fills the workflowType/taskQueue columns denormalized from the DSL for
// workflows stored before those columns existed. Without them, a child workflow discovered at
// runtime can't be matched back to the workflow it belongs to.
func backfillWorkflowHeaders(conn *gorm.DB) {
	var workflows []models.Workflow
	if err := conn.Where("dsl <> '' AND (workflow_type IS NULL OR workflow_type = '')").
		Find(&workflows).Error; err != nil {
		log.Printf("backfilling workflow headers: %v", err)
		return
	}
	for _, wf := range workflows {
		taskQueue, workflowType, err := api.ParseDSLHeader(wf.DSL)
		if err != nil || workflowType == "" {
			continue
		}
		if err := conn.Model(&models.Workflow{}).Where("id = ?", wf.ID).
			Updates(map[string]any{"workflow_type": workflowType, "task_queue": taskQueue}).Error; err != nil {
			log.Printf("backfilling workflow %s header: %v", wf.ID, err)
		}
	}
}

// resumeRunningExecutions re-attaches a completion watcher to every execution still marked
// running, so a backend restart mid-run doesn't leave it stuck at "running" forever.
func resumeRunningExecutions(conn *gorm.DB, deps *api.Deps) {
	var executions []models.Execution
	if err := conn.Where("status = ?", models.ExecutionRunning).Find(&executions).Error; err != nil {
		log.Printf("resuming running executions: %v", err)
		return
	}
	for _, execution := range executions {
		go api.WatchExecutionUntilClosed(deps, execution.ID)
	}
}
