package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/zigflow/zigflow/pkg/zigflow"
	"go.temporal.io/api/serviceerror"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"duraflow/backend/internal/dslhash"
	"duraflow/backend/internal/dslruntime"
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

// Saving a DSL is what makes a workflow runnable. There is no worker to restart: the save compiles
// the DSL with zigflow (exactly the validation `zigflow run` applied at startup), stores it as an
// immutable version named by its hash, points the workflow at that version, and publishes its
// schedule. The next run, on any worker in the pool, executes the new version; runs already in
// progress keep the version they started on.
//
// A DSL that doesn't build is still saved — the builder saves drafts mid-edit — but the workflow
// gets no current version, so a run is refused with zigflow's reason (Workflow.DSLError).

// applyDSLHeader refreshes the columns denormalized from the DSL's `document` header. The resolver
// matches Temporal child workflows back to a Workflow row through these two columns, so they are
// kept even for a DSL that doesn't build.
func applyDSLHeader(workflow *models.Workflow) {
	taskQueue, workflowType, err := parseDSLHeader(workflow.DSL)
	if err != nil {
		// A DSL that doesn't parse yet is normal mid-edit; just clear the derived columns so a
		// stale workflow type can't keep matching child workflows.
		workflow.TaskQueue, workflow.WorkflowType = "", ""
		return
	}
	workflow.TaskQueue, workflow.WorkflowType = taskQueue, workflowType
}

// compileWorkflowDSL sets the workflow's derived columns from its DSL and returns the build, or nil
// when the DSL is blank or doesn't build.
func compileWorkflowDSL(deps *Deps, workflow *models.Workflow) *dslruntime.Build {
	applyDSLHeader(workflow)
	workflow.CurrentHash, workflow.DSLError = "", ""

	build, err := deps.Runtime.Compile(workflow.DSL)
	switch {
	case err == nil:
		workflow.CurrentHash = build.Hash
		workflow.TaskQueue = build.TaskQueue
		workflow.WorkflowType = build.WorkflowType
		return build
	case errors.Is(err, dslruntime.ErrBlankDSL):
		return nil
	default:
		workflow.DSLError = err.Error()
		return nil
	}
}

// storeWorkflow writes the workflow row together with its DSL version and registered names, so a
// worker that sees the new current hash can always load it.
func storeWorkflow(tx *gorm.DB, workflow *models.Workflow, build *dslruntime.Build, create bool) error {
	if build != nil {
		version := models.DSLVersion{
			Hash: build.Hash, DSL: workflow.DSL, TaskQueue: build.TaskQueue,
			WorkflowType: build.WorkflowType, CreatedAt: time.Now(),
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&version).Error; err != nil {
			return fmt.Errorf("storing the DSL version: %w", err)
		}
	}

	if create {
		if err := tx.Create(workflow).Error; err != nil {
			return err
		}
	} else if err := tx.Save(workflow).Error; err != nil {
		return err
	}

	if err := tx.Where("workflow_id = ?", workflow.ID).Delete(&models.WorkflowRegistration{}).Error; err != nil {
		return fmt.Errorf("clearing workflow registrations: %w", err)
	}
	if build == nil {
		return nil
	}
	names := build.WorkflowNames()
	registrations := make([]models.WorkflowRegistration, 0, len(names))
	for _, name := range names {
		registrations = append(registrations, models.WorkflowRegistration{
			TaskQueue: build.TaskQueue, Name: name, WorkflowID: workflow.ID,
		})
	}
	if len(registrations) > 0 {
		if err := tx.Create(&registrations).Error; err != nil {
			return fmt.Errorf("storing workflow registrations: %w", err)
		}
	}
	return nil
}

// publishWorkflowSchedule brings the Temporal schedule in line with the saved DSL.
//
//   - A DSL that builds publishes its schedule (or deletes it when the `schedule:` block is gone)
//     through zigflow's own UpdateSchedules. The schedule is created with the version's hash in
//     its header, so every scheduled run starts on the version that was current when it was saved.
//   - A blank DSL retracts the previous schedule: there is nothing left to run.
//   - A DSL that doesn't build leaves the schedule alone; it keeps firing the last good version
//     until the DSL is fixed.
func publishWorkflowSchedule(ctx context.Context, deps *Deps, previousDSL string, workflow models.Workflow, build *dslruntime.Build) {
	if build == nil {
		if workflow.DSLError == "" {
			dropWorkflowSchedule(ctx, deps, previousDSL)
		}
		return
	}

	// Order matters: retract a schedule whose id the save changed before publishing the new one,
	// so a renamed schedule id can't leave two live schedules behind.
	dropRenamedWorkflowSchedule(ctx, deps, previousDSL, workflow.DSL)

	temporalClient, err := deps.Temporal.Get()
	if err != nil {
		log.Printf("[schedule] cannot reach Temporal to publish %s's schedule: %v", workflow.Name, err)
		return
	}
	pinned := dslhash.With(ctx, build.Hash)
	err = zigflow.UpdateSchedules(pinned, temporalClient, build.Doc, deps.Runtime.Env().Envvars)
	var exists *serviceerror.AlreadyExists
	if errors.As(err, &exists) {
		// Another save of a workflow with the same schedule id won a race; republish ours, which
		// deletes theirs first.
		err = zigflow.UpdateSchedules(pinned, temporalClient, build.Doc, deps.Runtime.Env().Envvars)
	}
	if err != nil {
		log.Printf("[schedule] publishing %s's schedule: %v", workflow.Name, err)
	}
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
		build := compileWorkflowDSL(deps, &workflow)
		if err := deps.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			return storeWorkflow(tx, &workflow, build, true)
		}); err != nil {
			return nil, huma.Error500InternalServerError("failed to create workflow", err)
		}
		deps.workflowsChanged()
		publishWorkflowSchedule(ctx, deps, "", workflow, build)
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
		// Two copies saving the same workflow at once would otherwise interleave their version
		// bumps and schedule publishes.
		unlock, err := deps.locker().Lock(ctx, "workflow:"+in.ID)
		if err != nil {
			return nil, huma.Error503ServiceUnavailable("could not lock the workflow for saving", err)
		}
		defer unlock()

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
		previousDSL := workflow.DSL
		dslChanged := in.Body.DSL != nil && *in.Body.DSL != workflow.DSL
		if dslChanged {
			workflow.DSL = *in.Body.DSL
			workflow.Version++
		}

		// Recompile when the DSL changed, and also when an unchanged DSL has no current version
		// yet — a save is how a workflow that failed to build under an older zigflow is retried.
		var build *dslruntime.Build
		recompile := dslChanged || (workflow.CurrentHash == "" && workflow.DSL != "")
		if recompile {
			build = compileWorkflowDSL(deps, &workflow)
		}
		if err := deps.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if !recompile {
				return tx.Save(&workflow).Error
			}
			return storeWorkflow(tx, &workflow, build, false)
		}); err != nil {
			return nil, huma.Error500InternalServerError("failed to update workflow", err)
		}
		if recompile {
			deps.workflowsChanged()
			publishWorkflowSchedule(ctx, deps, previousDSL, workflow, build)
		}
		return &workflowOutput{Body: workflow}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-workflow",
		Method:        http.MethodDelete,
		Path:          base + "/workflows/{id}",
		Summary:       "Delete a workflow with its runs and schedule",
		Tags:          []string{"Workflows"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{404},
	}, func(ctx context.Context, in *workflowIDInput) (*struct{}, error) {
		var workflow models.Workflow
		if err := deps.DB.WithContext(ctx).First(&workflow, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}

		if err := deleteWorkflowCascade(ctx, deps, workflow); err != nil {
			return nil, huma.Error500InternalServerError("failed to delete workflow", err)
		}
		return nil, nil
	})
}
