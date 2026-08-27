package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/models"
)

type projectIDInput struct {
	ID string `path:"id"`
}

type listProjectsOutput struct {
	Body []models.Project
}

type projectOutput struct {
	Body models.Project
}

type createProjectInput struct {
	Body struct {
		Name        string `json:"name" required:"true"`
		Description string `json:"description,omitempty"`
	}
}

type updateProjectInput struct {
	ID   string `path:"id"`
	Body struct {
		Name        *string `json:"name,omitempty"`
		Description *string `json:"description,omitempty"`
	}
}

func withWorkflowCount(deps *Deps, ctx context.Context, p *models.Project) {
	var count int64
	deps.DB.WithContext(ctx).Model(&models.Workflow{}).Where("project_id = ?", p.ID).Count(&count)
	p.WorkflowCount = int(count)
}

func registerProjectRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-projects",
		Method:      http.MethodGet,
		Path:        base + "/projects",
		Summary:     "List projects",
		Tags:        []string{"Projects"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *struct{}) (*listProjectsOutput, error) {
		var projects []models.Project
		if err := deps.DB.WithContext(ctx).Order("created_at desc").Find(&projects).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list projects", err)
		}
		for i := range projects {
			withWorkflowCount(deps, ctx, &projects[i])
		}
		return &listProjectsOutput{Body: projects}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-project",
		Method:        http.MethodPost,
		Path:          base + "/projects",
		Summary:       "Create a project",
		Tags:          []string{"Projects"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createProjectInput) (*projectOutput, error) {
		project := models.Project{Name: in.Body.Name, Description: in.Body.Description}
		if err := deps.DB.WithContext(ctx).Create(&project).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to create project", err)
		}
		return &projectOutput{Body: project}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-project",
		Method:      http.MethodGet,
		Path:        base + "/projects/{id}",
		Summary:     "Get a project",
		Tags:        []string{"Projects"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *projectIDInput) (*projectOutput, error) {
		var project models.Project
		if err := deps.DB.WithContext(ctx).First(&project, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("project not found")
		}
		withWorkflowCount(deps, ctx, &project)
		return &projectOutput{Body: project}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-project",
		Method:      http.MethodPatch,
		Path:        base + "/projects/{id}",
		Summary:     "Update a project",
		Tags:        []string{"Projects"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *updateProjectInput) (*projectOutput, error) {
		var project models.Project
		if err := deps.DB.WithContext(ctx).First(&project, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("project not found")
		}
		if in.Body.Name != nil {
			project.Name = *in.Body.Name
		}
		if in.Body.Description != nil {
			project.Description = *in.Body.Description
		}
		if err := deps.DB.WithContext(ctx).Save(&project).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to update project", err)
		}
		withWorkflowCount(deps, ctx, &project)
		return &projectOutput{Body: project}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-project",
		Method:        http.MethodDelete,
		Path:          base + "/projects/{id}",
		Summary:       "Delete a project",
		Tags:          []string{"Projects"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{404},
	}, func(ctx context.Context, in *projectIDInput) (*struct{}, error) {
		result := deps.DB.WithContext(ctx).Delete(&models.Project{}, "id = ?", in.ID)
		if result.Error != nil {
			return nil, huma.Error500InternalServerError("failed to delete project", result.Error)
		}
		if result.RowsAffected == 0 {
			return nil, huma.Error404NotFound("project not found")
		}
		return nil, nil
	})
}
