// Package api registers every Huma operation against an Echo router and owns
// the shared request-scoped auth plumbing.
package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
	"github.com/labstack/echo/v4"
	echomw "github.com/labstack/echo/v4/middleware"
	"gorm.io/gorm"

	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/temporalexec"
)

type Deps struct {
	Cfg      *config.Config
	DB       *gorm.DB
	Temporal *temporalexec.LazyClient
	Workers  *temporalexec.WorkerManager
}

type ctxKey string

const userIDCtxKey ctxKey = "userID"

const securityScheme = "bearerAuth"

// NewRouter builds the Echo instance, wires it to a Huma API (auto OpenAPI +
// Scalar docs), and registers every resource's operations.
func NewRouter(deps *Deps) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(echomw.Recover())
	e.Use(echomw.Logger())
	e.Use(echomw.CORSWithConfig(echomw.CORSConfig{
		AllowOrigins: deps.Cfg.Server.AllowedOrigins,
		AllowHeaders: []string{"Authorization", "Content-Type"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions},
	}))

	humaConfig := huma.DefaultConfig("Duraflow API", "0.1.0")
	humaConfig.DocsRenderer = huma.DocsRendererScalar
	humaConfig.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		securityScheme: {Type: "http", Scheme: "bearer", BearerFormat: "JWT"},
	}

	api := humaecho.NewV4(e, humaConfig)
	api.UseMiddleware(authMiddleware(api, deps.Cfg.Auth.JWTSecret))

	base := strings.TrimSuffix(deps.Cfg.Server.BasePath, "/")
	registerAuthRoutes(api, deps, base)
	registerProjectRoutes(api, deps, base)
	registerWorkflowRoutes(api, deps, base)
	registerExecutionRoutes(api, deps, base)
	registerScheduleRoutes(api, deps, base)
	registerWorkerRoutes(api, deps, base)

	return e
}

// authMiddleware enforces the bearer token for any operation that declares
// the bearerAuth security requirement, and stashes the resolved user id into
// the request context for handlers to read via currentUserID.
func authMiddleware(api huma.API, secret string) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		op := ctx.Operation()
		requiresAuth := false
		for _, req := range op.Security {
			if _, ok := req[securityScheme]; ok {
				requiresAuth = true
				break
			}
		}

		if !requiresAuth {
			next(ctx)
			return
		}

		token, ok := strings.CutPrefix(ctx.Header("Authorization"), "Bearer ")
		if !ok || token == "" {
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "missing bearer token")
			return
		}

		userID, err := auth.VerifyToken(secret, token)
		if err != nil {
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "invalid or expired token")
			return
		}

		next(huma.WithValue(ctx, userIDCtxKey, userID))
	}
}

func currentUserID(ctx context.Context) string {
	id, _ := ctx.Value(userIDCtxKey).(string)
	return id
}

func authSecurity() []map[string][]string {
	return []map[string][]string{{securityScheme: {}}}
}
