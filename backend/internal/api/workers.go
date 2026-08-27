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
		var worker models.Worker
		err := deps.DB.WithContext(ctx).
			Where("identity = ? AND task_queue = ?", in.Body.Identity, in.Body.TaskQueue).
			First(&worker).Error

		worker.Identity = in.Body.Identity
		worker.TaskQueue = in.Body.TaskQueue
		worker.Status = models.WorkerOnline
		worker.LastHeartbeatAt = time.Now()

		if err != nil {
			if createErr := deps.DB.WithContext(ctx).Create(&worker).Error; createErr != nil {
				return nil, huma.Error500InternalServerError("failed to register worker", createErr)
			}
		} else if saveErr := deps.DB.WithContext(ctx).Save(&worker).Error; saveErr != nil {
			return nil, huma.Error500InternalServerError("failed to update worker", saveErr)
		}

		return &workerOutput{Body: worker}, nil
	})
}
