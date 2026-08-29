package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/models"
)

type listWorkflowsInput struct {
	ProjectID string `path:"projectId"`
}

type listWorkflowsOutput struct {
	Body []models.Workflow
}

type workflowIDInput struct {
	ID string `path:"id"`
}

type workflowOutput struct {
	Body models.Workflow
}

type createWorkflowInput struct {
	ProjectID string `path:"projectId"`
	Body      struct {
		Name        string `json:"name" required:"true"`
		Description string `json:"description,omitempty"`
		DSL         string `json:"dsl,omitempty"`
	}
}

type updateWorkflowInput struct {
	ID   string `path:"id"`
	Body struct {
		Name        *string `json:"name,omitempty"`
		Description *string `json:"description,omitempty"`
		DSL         *string `json:"dsl,omitempty"`
	}
}

// syncWorkerRegistration starts/updates the workflow's zigflow worker process and reflects its
// presence in the `workers` table (best-effort — a workflow whose DSL doesn't yet have a valid
// document.taskQueue just doesn't get a row), so the Workers page shows real spawned processes
// rather than staying permanently empty.
func syncWorkerRegistration(deps *Deps, ctx context.Context, workflow models.Workflow) {
	deps.Workers.Sync(workflow.ID, workflow.Name, workflow.DSL)

	taskQueue, _, err := parseDSLHeader(workflow.DSL)
	if err != nil || taskQueue == "" {
		return
	}
	upsertWorker(deps, ctx, workflow.Name, taskQueue, models.WorkerOnline)
}

func stopWorkerRegistration(deps *Deps, ctx context.Context, workflow models.Workflow) {
	deps.Workers.Stop(workflow.ID)

	taskQueue, _, err := parseDSLHeader(workflow.DSL)
	if err != nil || taskQueue == "" {
		return
	}
	upsertWorker(deps, ctx, workflow.Name, taskQueue, models.WorkerOffline)
}

func registerWorkflowRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-workflows",
		Method:      http.MethodGet,
		Path:        base + "/projects/{projectId}/workflows",
		Summary:     "List a project's workflows",
		Tags:        []string{"Workflows"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *listWorkflowsInput) (*listWorkflowsOutput, error) {
		var workflows []models.Workflow
		if err := deps.DB.WithContext(ctx).Where("project_id = ?", in.ProjectID).
			Order("created_at desc").Find(&workflows).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list workflows", err)
		}
		return &listWorkflowsOutput{Body: workflows}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-workflow",
		Method:        http.MethodPost,
		Path:          base + "/projects/{projectId}/workflows",
		Summary:       "Create a workflow",
		Tags:          []string{"Workflows"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusCreated,
		Errors:        []int{404},
	}, func(ctx context.Context, in *createWorkflowInput) (*workflowOutput, error) {
		var project models.Project
		if err := deps.DB.WithContext(ctx).First(&project, "id = ?", in.ProjectID).Error; err != nil {
			return nil, huma.Error404NotFound("project not found")
		}

		workflow := models.Workflow{
			ProjectID:   in.ProjectID,
			Name:        in.Body.Name,
			Description: in.Body.Description,
			Version:     1,
			DSL:         in.Body.DSL,
		}
		if err := deps.DB.WithContext(ctx).Create(&workflow).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to create workflow", err)
		}
		syncWorkerRegistration(deps, ctx, workflow)
		return &workflowOutput{Body: workflow}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-workflow",
		Method:      http.MethodGet,
		Path:        base + "/workflows/{id}",
		Summary:     "Get a workflow",
		Tags:        []string{"Workflows"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *workflowIDInput) (*workflowOutput, error) {
		var workflow models.Workflow
		if err := deps.DB.WithContext(ctx).First(&workflow, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}
		return &workflowOutput{Body: workflow}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-workflow",
		Method:      http.MethodPatch,
		Path:        base + "/workflows/{id}",
		Summary:     "Update a workflow (bumps version when the DSL changes)",
		Tags:        []string{"Workflows"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *updateWorkflowInput) (*workflowOutput, error) {
		var workflow models.Workflow
		if err := deps.DB.WithContext(ctx).First(&workflow, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}
		if in.Body.Name != nil {
			workflow.Name = *in.Body.Name
		}
		if in.Body.Description != nil {
			workflow.Description = *in.Body.Description
		}
		if in.Body.DSL != nil && *in.Body.DSL != workflow.DSL {
			workflow.DSL = *in.Body.DSL
			workflow.Version++
		}
		if err := deps.DB.WithContext(ctx).Save(&workflow).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to update workflow", err)
		}
		syncWorkerRegistration(deps, ctx, workflow)
		return &workflowOutput{Body: workflow}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-workflow",
		Method:        http.MethodDelete,
		Path:          base + "/workflows/{id}",
		Summary:       "Delete a workflow",
		Tags:          []string{"Workflows"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{404},
	}, func(ctx context.Context, in *workflowIDInput) (*struct{}, error) {
		var workflow models.Workflow
		if err := deps.DB.WithContext(ctx).First(&workflow, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}

		if err := deps.DB.WithContext(ctx).Delete(&models.Workflow{}, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to delete workflow", err)
		}
		stopWorkerRegistration(deps, ctx, workflow)
		return nil, nil
	})
}
