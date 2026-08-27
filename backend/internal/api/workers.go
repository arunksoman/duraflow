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

// upsertWorker records a worker's presence — identity+taskQueue is the natural key, matching
// how zigflow workers self-identify. Used both by the register-worker endpoint below and by
// workflows.go, which calls it whenever a workflow's zigflow worker process is started/stopped.
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
		var workers []models.Worker
		if err := deps.DB.WithContext(ctx).Order("last_heartbeat_at desc").Find(&workers).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list workers", err)
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
