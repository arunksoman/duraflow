// Package app wires one backend process: whichever roles its config names, on top of the shared
// database and Temporal. cmd/server runs one App; the end-to-end tests run several side by side to
// exercise exactly what a multi-copy deployment runs.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"github.com/zigflow/zigflow/pkg/utils"
	"gorm.io/gorm"

	"duraflow/backend/internal/api"
	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/coord"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/dslruntime"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

const (
	shutdownTimeout = 5 * time.Second
	// watchSweepInterval is how often the jobs leader makes sure every running execution has a
	// completion watcher, which covers watch requests lost on the way to it.
	watchSweepInterval = 30 * time.Second
)

// App is one backend process.
//
//   - api role: REST, live run streams and CloudEvents ingest. Every api copy also competes for
//     the jobs leader lock; the leader runs completion watchers and resolver maintenance.
//   - worker role: the worker pool, which executes every saved workflow through zigflow as a
//     library.
//
// Copies share state through the database and, on Postgres, LISTEN/NOTIFY and advisory locks (see
// internal/coord), so any number of copies of either role can run side by side.
type App struct {
	Cfg  *config.Config
	Deps *api.Deps
	Pool *dslruntime.Pool

	resolver      *temporalexec.Resolver
	notifier      coord.Notifier
	elector       coord.Elector
	startNotifier func(context.Context)
	leading       atomic.Bool
	listener      net.Listener
}

// New connects to the database, migrates it, seeds the admin and backfills DSL versions (one copy
// at a time on Postgres), and wires every component the configured roles need. Nothing runs until
// Run.
func New(ctx context.Context, cfg *config.Config) (*App, error) {
	ConfigureZigflowLogging(cfg.Worker.LogLevel)

	conn, err := db.Connect(cfg.Database)
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}

	a := &App{Cfg: cfg}
	var locks coord.Locker
	if cfg.Database.Driver == "postgres" {
		sqlDB, err := conn.DB()
		if err != nil {
			return nil, fmt.Errorf("database: %w", err)
		}
		pg := coord.NewPostgres(cfg.Database.DSN, sqlDB)
		a.notifier, a.elector, locks, a.startNotifier = pg, pg, pg, pg.Start
	} else {
		m := coord.NewMemory()
		a.notifier, a.elector, locks, a.startNotifier = m, m, m, func(context.Context) {}
	}

	temporalClient := temporalexec.NewLazyClientWithOptions(
		temporalexec.ClientOptions(cfg.Temporal.Address, cfg.Temporal.Namespace, cfg.Worker.Identity))

	cache, err := newDSLCache(cfg, conn)
	if err != nil {
		return nil, fmt.Errorf("zigflow runtime: %w", err)
	}

	var bus events.Bus
	if cfg.Database.Driver == "postgres" {
		bus = events.NewRelay(a.notifier, func(ctx context.Context, seq uint64) (models.ExecutionEvent, error) {
			var ev models.ExecutionEvent
			err := conn.WithContext(ctx).First(&ev, "seq = ?", seq).Error
			return ev, err
		})
	} else {
		bus = events.NewBroker()
	}
	a.resolver = temporalexec.NewResolver(conn, temporalClient, bus, cfg.Telemetry.RetentionPerExecution)

	a.Deps = &api.Deps{
		Cfg:      cfg,
		DB:       conn,
		Temporal: temporalClient,
		Runtime:  cache,
		Bus:      bus,
		Resolver: a.resolver,
		Locks:    locks,
		Notifier: a.notifier,
	}

	if err := a.startup(ctx); err != nil {
		return nil, fmt.Errorf("startup: %w", err)
	}

	// A child workflow — or a run Temporal started from a workflow's own schedule — only becomes
	// visible once its first event arrives, so this is where its completion watcher is requested.
	a.resolver.OnExecutionDiscovered = func(execution models.Execution) {
		a.Deps.WatchExecution(execution.ID)
	}
	a.notifier.Listen(coord.ChannelWatch, func(executionID string) {
		if a.leading.Load() {
			go api.WatchExecutionUntilClosed(a.Deps, executionID)
		}
	})
	a.notifier.Listen(coord.ChannelForget, func(payload string) {
		a.resolver.Forget(api.ForgetPayload(payload)...)
	})

	if cfg.HasRole(config.RoleWorker) {
		a.Pool = dslruntime.NewPool(dslruntime.PoolOptions{
			Identity:   cfg.Worker.Identity,
			Temporal:   temporalClient.Get,
			DB:         conn,
			Dispatcher: &dslruntime.Dispatcher{Cache: cache, Directory: dslruntime.NewDirectory(conn)},

			RefreshInterval:                        cfg.Worker.RefreshInterval,
			HeartbeatInterval:                      cfg.Worker.HeartbeatInterval,
			DeadlockDetectionTimeout:               cfg.Worker.DeadlockDetectionTimeout,
			StopTimeout:                            cfg.Worker.StopTimeout,
			MaxConcurrentActivityExecutionSize:     cfg.Worker.MaxConcurrentActivities,
			MaxConcurrentWorkflowTaskExecutionSize: cfg.Worker.MaxConcurrentWorkflowTasks,
		})
		a.notifier.Listen(coord.ChannelWorkflows, func(string) { a.Pool.Kick() })
	}

	a.listener, err = net.Listen("tcp", cfg.Server.Addr())
	if err != nil {
		return nil, fmt.Errorf("listening on %s: %w", cfg.Server.Addr(), err)
	}
	return a, nil
}

// Addr is the address the HTTP server listens on.
func (a *App) Addr() string { return a.listener.Addr().String() }

// Leading reports whether this copy currently runs the once-only jobs.
func (a *App) Leading() bool { return a.leading.Load() }

// Run serves until ctx is cancelled, then shuts down: the HTTP server first, then the worker pool,
// which lets in-flight activities finish.
func (a *App) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer a.Deps.Temporal.Close()

	// Every Listen call happened in New: the Postgres notifier fixes its channel list when it starts.
	a.startNotifier(ctx)

	var wg sync.WaitGroup
	if a.Pool != nil {
		wg.Go(func() { a.Pool.Run(ctx) })
	}

	var handler http.Handler
	if a.Cfg.HasRole(config.RoleAPI) {
		go a.resolver.Run(ctx)
		go a.elector.Run(ctx, func(leaderCtx context.Context) {
			a.leading.Store(true)
			defer a.leading.Store(false)
			a.runJobs(leaderCtx)
		})
		handler = api.NewRouter(a.Deps)
		log.Printf("duraflow api listening on %s (docs at /docs, api at %s), roles %v",
			a.Addr(), a.Cfg.Server.BasePath, a.Cfg.RoleSet)
	} else {
		handler = healthHandler(a.Pool)
		log.Printf("duraflow worker health endpoint on %s/healthz, roles %v", a.Addr(), a.Cfg.RoleSet)
	}

	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	serveErr := make(chan error, 1)
	go func() {
		if err := server.Serve(a.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			cancel()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()
	_ = server.Shutdown(shutdownCtx)
	wg.Wait()

	select {
	case err := <-serveErr:
		return err
	default:
		return nil
	}
}

// newDSLCache builds the zigflow environment every compile in this process uses. Only a process
// that runs workflows needs the CloudEvents emitter; an API-only process compiles to validate.
func newDSLCache(cfg *config.Config, conn *gorm.DB) (*dslruntime.Cache, error) {
	env, err := dslruntime.NewEnv()
	if err != nil {
		return nil, err
	}
	env.Envvars = utils.LoadEnvvars(strings.TrimSuffix(cfg.Worker.EnvPrefix, "_") + "_")
	env.ContainerRuntime = cfg.Worker.ContainerRuntime
	env.ContainerNamespace = cfg.Worker.ContainerNamespace
	env.ContainerServiceAccount = cfg.Worker.ContainerServiceAccount
	if cfg.HasRole(config.RoleWorker) {
		path, err := dslruntime.WriteCloudEventsConfig("", cfg.Telemetry.SinkURL, cfg.Telemetry.Token, cfg.Telemetry.Timeout)
		if err != nil {
			return nil, err
		}
		env.CloudEventsConfigPath = path
	}
	return dslruntime.NewCache(env, dslruntime.DBStore{DB: conn}, cfg.Worker.CacheSize), nil
}

// startup migrates the schema, seeds the admin and backfills DSL versions. It holds a lock so
// that copies starting together run it one at a time.
func (a *App) startup(ctx context.Context) error {
	unlock, err := a.Deps.Locks.Lock(ctx, "startup")
	if err != nil {
		return err
	}
	defer unlock()

	if err := db.Migrate(a.Deps.DB); err != nil {
		return err
	}
	if err := SeedAdmin(a.Cfg, a.Deps.DB); err != nil {
		return err
	}
	api.BackfillDSLVersions(ctx, a.Deps)
	return nil
}

// runJobs is the work exactly one api copy does at a time. It returns when leadership is lost.
func (a *App) runJobs(ctx context.Context) {
	go a.resolver.RunMaintenance(ctx)

	ResumeRunningExecutions(a.Deps)
	ticker := time.NewTicker(watchSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ResumeRunningExecutions(a.Deps)
		}
	}
}

// ConfigureZigflowLogging sets zigflow's global zerolog level; it logs every build at debug.
func ConfigureZigflowLogging(level string) {
	parsed, err := zerolog.ParseLevel(strings.ToLower(level))
	if err != nil || level == "" {
		parsed = zerolog.WarnLevel
	}
	zerolog.SetGlobalLevel(parsed)
}

// healthHandler serves a worker-only process's liveness endpoint, listing the task queues it polls.
func healthHandler(pool *dslruntime.Pool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "taskQueues": pool.TaskQueues()})
	})
	return mux
}

// SeedAdmin creates the configured admin user on first boot if the users table is empty, so
// there's always a way to log in against a fresh database.
func SeedAdmin(cfg *config.Config, conn *gorm.DB) error {
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

// ResumeRunningExecutions attaches a completion watcher to every execution still marked running
// (a no-op for one already watched), so a restart or a leader change mid-run doesn't leave runs
// stuck at "running" forever.
func ResumeRunningExecutions(deps *api.Deps) {
	var ids []string
	if err := deps.DB.Model(&models.Execution{}).Where("status = ?", models.ExecutionRunning).
		Pluck("id", &ids).Error; err != nil {
		log.Printf("resuming running executions: %v", err)
		return
	}
	for _, id := range ids {
		go api.WatchExecutionUntilClosed(deps, id)
	}
}
