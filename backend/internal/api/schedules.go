package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/models"
)

type listSchedulesInput struct {
	WorkflowID string `query:"workflowId"`
}

type listSchedulesOutput struct {
	Body []models.Schedule
}

type scheduleIDInput struct {
	ID string `path:"id"`
}

type scheduleOutput struct {
	Body models.Schedule
}

type createScheduleInput struct {
	Body struct {
		WorkflowID string `json:"workflowId" required:"true"`
		Cron       string `json:"cron" required:"true"`
		Timezone   string `json:"timezone,omitempty"`
		Enabled    *bool  `json:"enabled,omitempty"`
	}
}

type updateScheduleInput struct {
	ID   string `path:"id"`
	Body struct {
		Cron     *string `json:"cron,omitempty"`
		Timezone *string `json:"timezone,omitempty"`
		Enabled  *bool   `json:"enabled,omitempty"`
	}
}

func registerScheduleRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-schedules",
		Method:      http.MethodGet,
		Path:        base + "/schedules",
		Summary:     "List schedules, optionally filtered by workflowId",
		Tags:        []string{"Schedules"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *listSchedulesInput) (*listSchedulesOutput, error) {
		query := deps.DB.WithContext(ctx).Order("created_at desc")
		if in.WorkflowID != "" {
			query = query.Where("workflow_id = ?", in.WorkflowID)
		}
		var schedules []models.Schedule
		if err := query.Find(&schedules).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list schedules", err)
		}
		return &listSchedulesOutput{Body: schedules}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-schedule",
		Method:        http.MethodPost,
		Path:          base + "/schedules",
		Summary:       "Create a schedule",
		Tags:          []string{"Schedules"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusCreated,
		Errors:        []int{404},
	}, func(ctx context.Context, in *createScheduleInput) (*scheduleOutput, error) {
		var wf models.Workflow
		if err := deps.DB.WithContext(ctx).First(&wf, "id = ?", in.Body.WorkflowID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}

		timezone := in.Body.Timezone
		if timezone == "" {
			timezone = "UTC"
		}
		enabled := true
		if in.Body.Enabled != nil {
			enabled = *in.Body.Enabled
		}

		schedule := models.Schedule{
			WorkflowID: in.Body.WorkflowID,
			Cron:       in.Body.Cron,
			Timezone:   timezone,
			Enabled:    enabled,
		}
		if err := deps.DB.WithContext(ctx).Create(&schedule).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to create schedule", err)
		}
		return &scheduleOutput{Body: schedule}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-schedule",
		Method:      http.MethodPatch,
		Path:        base + "/schedules/{id}",
		Summary:     "Update a schedule",
		Tags:        []string{"Schedules"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *updateScheduleInput) (*scheduleOutput, error) {
		var schedule models.Schedule
		if err := deps.DB.WithContext(ctx).First(&schedule, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("schedule not found")
		}
		if in.Body.Cron != nil {
			schedule.Cron = *in.Body.Cron
		}
		if in.Body.Timezone != nil {
			schedule.Timezone = *in.Body.Timezone
		}
		if in.Body.Enabled != nil {
			schedule.Enabled = *in.Body.Enabled
		}
		if err := deps.DB.WithContext(ctx).Save(&schedule).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to update schedule", err)
		}
		return &scheduleOutput{Body: schedule}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-schedule",
		Method:        http.MethodDelete,
		Path:          base + "/schedules/{id}",
		Summary:       "Delete a schedule",
		Tags:          []string{"Schedules"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{404},
	}, func(ctx context.Context, in *scheduleIDInput) (*struct{}, error) {
		result := deps.DB.WithContext(ctx).Delete(&models.Schedule{}, "id = ?", in.ID)
		if result.Error != nil {
			return nil, huma.Error500InternalServerError("failed to delete schedule", result.Error)
		}
		if result.RowsAffected == 0 {
			return nil, huma.Error404NotFound("schedule not found")
		}
		return nil, nil
	})
}
