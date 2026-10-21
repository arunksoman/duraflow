package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/models"
)

func TestLogin(t *testing.T) {
	env := newTestEnv(t)

	var session sessionBody
	resp := env.expect(http.MethodPost, "/api/auth/login",
		map[string]string{"email": "ada@example.com", "password": "password123"}, http.StatusOK, &session)
	if session.User.ID != env.user.ID || session.Token == "" || session.ExpiresAt.Before(time.Now()) {
		t.Errorf("session: %+v", session)
	}
	if strings.Contains(string(resp.Body), "passwordHash") || strings.Contains(string(resp.Body), "$2") {
		t.Error("login response leaks the password hash")
	}
	if id, err := auth.VerifyToken("test-secret", session.Token); err != nil || id != env.user.ID {
		t.Errorf("issued token invalid: %v", err)
	}

	for name, body := range map[string]map[string]string{
		"wrong password": {"email": "ada@example.com", "password": "nope"},
		"unknown email":  {"email": "who@example.com", "password": "password123"},
	} {
		t.Run(name, func(t *testing.T) {
			if resp := env.request(http.MethodPost, "/api/auth/login", body); resp.Status != http.StatusUnauthorized {
				t.Errorf("status %d", resp.Status)
			}
		})
	}
	if resp := env.request(http.MethodPost, "/api/auth/login", map[string]string{"email": "ada@example.com"}); resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("missing password: status %d", resp.Status)
	}
}

func TestLoginWithNegativeTTLIssuesExpiredToken(t *testing.T) {
	env := newTestEnv(t)
	env.deps.Cfg.Auth.TokenTTL = -time.Minute
	var session sessionBody
	env.expect(http.MethodPost, "/api/auth/login",
		map[string]string{"email": "ada@example.com", "password": "password123"}, http.StatusOK, &session)
	env.token = session.Token
	if resp := env.request(http.MethodGet, "/api/auth/me", nil); resp.Status != http.StatusUnauthorized {
		t.Errorf("expired token accepted: %d", resp.Status)
	}
}

func TestCurrentUser(t *testing.T) {
	env := newTestEnv(t)

	var me models.User
	env.expect(http.MethodGet, "/api/auth/me", nil, http.StatusOK, &me)
	if me.Email != "ada@example.com" || me.Role != models.RoleAdmin {
		t.Errorf("me: %+v", me)
	}

	cases := map[string][]string{
		"no header":       {"Authorization", ""},
		"not bearer":      {"Authorization", "Basic abc"},
		"empty bearer":    {"Authorization", "Bearer "},
		"forged token":    {"Authorization", "Bearer not-a-jwt"},
		"wrong signature": {"Authorization", "Bearer " + mustToken(t, "other-secret", env.user.ID)},
	}
	for name, header := range cases {
		t.Run(name, func(t *testing.T) {
			if resp := env.request(http.MethodGet, "/api/auth/me", nil, header...); resp.Status != http.StatusUnauthorized {
				t.Errorf("status %d", resp.Status)
			}
		})
	}

	// A valid token for a user that no longer exists.
	env.token = mustToken(t, "test-secret", "ghost")
	if resp := env.request(http.MethodGet, "/api/auth/me", nil); resp.Status != http.StatusNotFound {
		t.Errorf("deleted user: status %d", resp.Status)
	}
}

func mustToken(t *testing.T, secret, userID string) string {
	t.Helper()
	token, _, err := auth.IssueToken(secret, userID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestEveryOperationButLoginAndIngestRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	resp := env.request(http.MethodGet, "/openapi.json", nil, "Authorization", "")
	if resp.Status != http.StatusOK {
		t.Fatalf("openapi.json: %d", resp.Status)
	}
	var spec struct {
		Paths map[string]map[string]struct {
			OperationID string                `json:"operationId"`
			Security    []map[string][]string `json:"security"`
		} `json:"paths"`
	}
	resp.decode(t, &spec)

	public := map[string]bool{"login": true, "ingest-zigflow-event": true}
	seen := 0
	for path, ops := range spec.Paths {
		for method, op := range ops {
			seen++
			_, secured := firstScheme(op.Security)[securityScheme]
			if public[op.OperationID] == secured {
				t.Errorf("%s %s (%s): secured=%v", method, path, op.OperationID, secured)
			}
		}
	}
	if seen < 20 {
		t.Errorf("spec lists only %d operations", seen)
	}
}

func firstScheme(security []map[string][]string) map[string][]string {
	if len(security) == 0 {
		return nil
	}
	return security[0]
}

func TestCORSPreflight(t *testing.T) {
	env := newTestEnv(t)
	req, _ := http.NewRequest(http.MethodOptions, env.server.URL+"/api/projects", nil)
	req.Header.Set("Origin", "http://app.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	req.Header.Set("Access-Control-Request-Headers", "Authorization")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://app.test" {
		t.Errorf("allow-origin %q", got)
	}
	if !strings.Contains(resp.Header.Get("Access-Control-Allow-Methods"), http.MethodPatch) {
		t.Errorf("allow-methods %q", resp.Header.Get("Access-Control-Allow-Methods"))
	}
}

func TestCurrentUserIDWithoutAuth(t *testing.T) {
	if id := currentUserID(t.Context()); id != "" {
		t.Errorf("got %q", id)
	}
}
