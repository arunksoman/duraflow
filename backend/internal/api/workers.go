package api

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/models"
)

type listWorkersOutput struct {
	Body []models.Worker
}

type workerOutput struct {
	Body models.Worker
}

type registerWorkerInput struct {
	Body struct {
		Identity  string `json:"identity" required:"true"`
		TaskQueue string `json:"taskQueue" required:"true"`
	}
}

// The Workers page lists one row per (worker process, task queue). Worker-pool processes keep
// their own rows fresh with a heartbeat (dslruntime.Pool); a row whose heartbeat stopped is shown
// offline, so a process that crashed or lost its host doesn't keep looking alive.

// staleAfterHeartbeats is how many heartbeat intervals a row may miss before it's reported
// offline.
const staleAfterHeartbeats = 3

// workerRowRetention is how long an offline row stays on the page before it's removed.
const workerRowRetention = 24 * time.Hour

// upsertWorker records a worker's presence — identity+taskQueue is the natural key. Used by the
// register-worker endpoint, for workers outside the pool that want to appear on the page.
func upsertWorker(deps *Deps, ctx context.Context, identity, taskQueue string, status models.WorkerStatus) {
	if identity == "" || taskQueue == "" {
		return
	}

	var worker models.Worker
	err := deps.DB.WithContext(ctx).
		Where("identity = ? AND task_queue = ?", identity, taskQueue).
		First(&worker).Error

	worker.Identity = identity
	worker.TaskQueue = taskQueue
	worker.Status = status
	worker.LastHeartbeatAt = time.Now()

	if err != nil {
		_ = deps.DB.WithContext(ctx).Create(&worker).Error
	} else {
		_ = deps.DB.WithContext(ctx).Save(&worker).Error
	}
}

func registerWorkerRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-workers",
		Method:      http.MethodGet,
		Path:        base + "/workers",
		Summary:     "List workers",
		Tags:        []string{"Workers"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *struct{}) (*listWorkersOutput, error) {
		now := time.Now()
		_ = deps.DB.WithContext(ctx).Where("last_heartbeat_at < ?", now.Add(-workerRowRetention)).
			Delete(&models.Worker{}).Error

		var workers []models.Worker
		if err := deps.DB.WithContext(ctx).Order("last_heartbeat_at desc").Find(&workers).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list workers", err)
		}
		interval := deps.Cfg.Worker.HeartbeatInterval
		if interval <= 0 {
			interval = 10 * time.Second
		}
		staleBefore := now.Add(-staleAfterHeartbeats * interval)
		for i := range workers {
			if workers[i].Status == models.WorkerOnline && workers[i].LastHeartbeatAt.Before(staleBefore) {
				workers[i].Status = models.WorkerOffline
			}
		}
		return &listWorkersOutput{Body: workers}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "register-worker",
		Method:      http.MethodPost,
		Path:        base + "/workers",
		Summary:     "Register a worker or record its heartbeat",
		Tags:        []string{"Workers"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *registerWorkerInput) (*workerOutput, error) {
		upsertWorker(deps, ctx, in.Body.Identity, in.Body.TaskQueue, models.WorkerOnline)

		var worker models.Worker
		if err := deps.DB.WithContext(ctx).
			Where("identity = ? AND task_queue = ?", in.Body.Identity, in.Body.TaskQueue).
			First(&worker).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to register worker", err)
		}
		return &workerOutput{Body: worker}, nil
	})
}
