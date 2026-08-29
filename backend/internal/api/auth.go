package api

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/models"
)

type sessionBody struct {
	User      models.User `json:"user"`
	Token     string      `json:"token"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

type loginInput struct {
	Body struct {
		Email    string `json:"email" required:"true"`
		Password string `json:"password" required:"true"`
	}
}

type sessionOutput struct {
	Body sessionBody
}

type meOutput struct {
	Body models.User
}

func registerAuthRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "login",
		Method:      http.MethodPost,
		Path:        base + "/auth/login",
		Summary:     "Log in with email and password",
		Tags:        []string{"Auth"},
		Errors:      []int{401},
	}, func(ctx context.Context, in *loginInput) (*sessionOutput, error) {
		var user models.User
		if err := deps.DB.WithContext(ctx).Where("email = ?", in.Body.Email).First(&user).Error; err != nil {
			return nil, huma.Error401Unauthorized("invalid email or password")
		}
		if !auth.CheckPassword(user.PasswordHash, in.Body.Password) {
			return nil, huma.Error401Unauthorized("invalid email or password")
		}

		token, expiresAt, err := auth.IssueToken(deps.Cfg.Auth.JWTSecret, user.ID, deps.Cfg.Auth.TokenTTL)
		if err != nil {
			return nil, huma.Error500InternalServerError("failed to issue token", err)
		}

		return &sessionOutput{Body: sessionBody{User: user, Token: token, ExpiresAt: expiresAt}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-current-user",
		Method:      http.MethodGet,
		Path:        base + "/auth/me",
		Summary:     "Get the authenticated user",
		Tags:        []string{"Auth"},
		Security:    authSecurity(),
		Errors:      []int{401, 404},
	}, func(ctx context.Context, in *struct{}) (*meOutput, error) {
		var user models.User
		if err := deps.DB.WithContext(ctx).First(&user, "id = ?", currentUserID(ctx)).Error; err != nil {
			return nil, huma.Error404NotFound("user not found")
		}
		return &meOutput{Body: user}, nil
	})
}
