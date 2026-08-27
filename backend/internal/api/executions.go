package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/models"
)

// executionDTO mirrors the frontend's Execution type (src/lib/types/index.ts)
// exactly, decoding the model's raw JSON columns into plain maps for the API.
type executionDTO struct {
	ID                string                 `json:"id"`
	WorkflowID        string                 `json:"workflowId"`
	WorkflowName      string                 `json:"workflowName"`
	Status            models.ExecutionStatus `json:"status"`
	StartedAt         time.Time              `json:"startedAt"`
	CompletedAt       *time.Time             `json:"completedAt,omitempty"`
	Input             map[string]any         `json:"input,omitempty"`
	Output            map[string]any         `json:"output,omitempty"`
	ParentExecutionID *string                `json:"parentExecutionId,omitempty"`
}

func toExecutionDTO(e models.Execution, workflowName string) executionDTO {
	dto := executionDTO{
		ID:                e.ID,
		WorkflowID:        e.WorkflowID,
		WorkflowName:      workflowName,
		Status:            e.Status,
		StartedAt:         e.StartedAt,
		CompletedAt:       e.CompletedAt,
		ParentExecutionID: e.ParentExecutionID,
	}
	if len(e.Input) > 0 {
		_ = json.Unmarshal(e.Input, &dto.Input)
	}
	if len(e.Output) > 0 {
		_ = json.Unmarshal(e.Output, &dto.Output)
	}
	return dto
}

func workflowName(deps *Deps, ctx context.Context, workflowID string) string {
	var workflow models.Workflow
	deps.DB.WithContext(ctx).Select("name").First(&workflow, "id = ?", workflowID)
	return workflow.Name
}

type listExecutionsInput struct {
	WorkflowID string `path:"id"`
}

type listExecutionsOutput struct {
	Body []executionDTO
}

type executionIDInput struct {
	ID string `path:"id"`
}

type executionOutput struct {
	Body executionDTO
}

type createExecutionInput struct {
	WorkflowID string `path:"id"`
	Body       struct {
		Input map[string]any `json:"input,omitempty"`
	}
}

type updateExecutionInput struct {
	ID   string `path:"id"`
	Body struct {
		Status *models.ExecutionStatus `json:"status,omitempty"`
		Output map[string]any          `json:"output,omitempty"`
	}
}

func registerExecutionRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-executions",
		Method:      http.MethodGet,
		Path:        base + "/workflows/{id}/executions",
		Summary:     "List a workflow's executions",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *listExecutionsInput) (*listExecutionsOutput, error) {
		var executions []models.Execution
		if err := deps.DB.WithContext(ctx).Where("workflow_id = ?", in.WorkflowID).
			Order("started_at desc").Find(&executions).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list executions", err)
		}
		name := workflowName(deps, ctx, in.WorkflowID)
		dtos := make([]executionDTO, len(executions))
		for i, e := range executions {
			dtos[i] = toExecutionDTO(e, name)
		}
		return &listExecutionsOutput{Body: dtos}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-execution",
		Method:        http.MethodPost,
		Path:          base + "/workflows/{id}/executions",
		Summary:       "Start a workflow execution",
		Tags:          []string{"Executions"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusCreated,
		Errors:        []int{404},
	}, func(ctx context.Context, in *createExecutionInput) (*executionOutput, error) {
		var wf models.Workflow
		if err := deps.DB.WithContext(ctx).First(&wf, "id = ?", in.WorkflowID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}

		inputJSON, _ := json.Marshal(in.Body.Input)
		execution := models.Execution{
			WorkflowID: in.WorkflowID,
			Status:     models.ExecutionRunning,
			StartedAt:  time.Now(),
			Input:      inputJSON,
		}
		if err := deps.DB.WithContext(ctx).Create(&execution).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to create execution", err)
		}
		return &executionOutput{Body: toExecutionDTO(execution, wf.Name)}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-execution",
		Method:      http.MethodGet,
		Path:        base + "/executions/{id}",
		Summary:     "Get an execution",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *executionIDInput) (*executionOutput, error) {
		var execution models.Execution
		if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("execution not found")
		}
		return &executionOutput{Body: toExecutionDTO(execution, workflowName(deps, ctx, execution.WorkflowID))}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-execution",
		Method:      http.MethodPatch,
		Path:        base + "/executions/{id}",
		Summary:     "Update an execution's status/output",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *updateExecutionInput) (*executionOutput, error) {
		var execution models.Execution
		if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("execution not found")
		}

		if in.Body.Status != nil {
			execution.Status = *in.Body.Status
			if execution.Status != models.ExecutionRunning && execution.CompletedAt == nil {
				now := time.Now()
				execution.CompletedAt = &now
			}
		}
		if in.Body.Output != nil {
			outputJSON, _ := json.Marshal(in.Body.Output)
			execution.Output = outputJSON
		}

		if err := deps.DB.WithContext(ctx).Save(&execution).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to update execution", err)
		}
		return &executionOutput{Body: toExecutionDTO(execution, workflowName(deps, ctx, execution.WorkflowID))}, nil
	})
}
