package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"gorm.io/gorm/clause"

	"duraflow/backend/internal/models"
)

// This endpoint is the reason the UI can say anything at all about a run. Each `zigflow run`
// worker this server spawns is handed a CloudEvents config pointing here (see
// temporalexec.WorkerManager.writeCloudEventsConfig), and then POSTs one event per task
// lifecycle moment: started, retried, cancelled, faulted, completed — each carrying that task's
// input, output, and the whole workflow state at that point.
//
// Two properties of zigflow's emitter shape everything below:
//
//   - It is NOT replay-guarded. Every workflow-task replay re-emits the entire set of events so
//     far, so duplicates are the norm, not the exception. They're collapsed by content hash.
//   - It is synchronous: the workflow goroutine blocks on this HTTP response. So this handler
//     does one indexed insert and nothing else — no Temporal calls, no joins. Working out which
//     execution an event belongs to happens afterwards, on temporalexec.Resolver's goroutine.

// storedEventTypes is the allowlist of zigflow event types (minus their `dev.zigflow.` prefix).
// Anything else a future zigflow emits is acknowledged and dropped rather than stored.
var storedEventTypes = map[string]bool{
	models.EventWorkflowStarted:   true,
	models.EventWorkflowCompleted: true,
	models.EventTaskStarted:       true,
	models.EventTaskRetried:       true,
	models.EventTaskCancelled:     true,
	models.EventTaskFaulted:       true,
	models.EventTaskCompleted:     true,
	models.EventIterationComplete: true,
}

type ingestEventInput struct {
	Token       string `header:"X-Duraflow-Token"`
	ID          string `header:"ce-id"`
	Type        string `header:"ce-type"`
	Source      string `header:"ce-source"`
	Subject     string `header:"ce-subject"`
	Time        string `header:"ce-time"`
	ContentType string `header:"Content-Type"`
	RawBody     []byte
}

// structuredEnvelope is the batteries-included fallback: the CloudEvents SDK sends binary mode
// (ce-* headers) by default, but a config change on zigflow's side could switch it to structured
// mode, where everything arrives inside the body instead.
type structuredEnvelope struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Source  string          `json:"source"`
	Subject string          `json:"subject"`
	Time    string          `json:"time"`
	Data    json.RawMessage `json:"data"`
}

func registerTelemetryRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID:   "ingest-zigflow-event",
		Method:        http.MethodPost,
		Path:          base + "/internal/zigflow/events",
		Summary:       "Receive a CloudEvent from a zigflow worker",
		Tags:          []string{"Internal"},
		DefaultStatus: http.StatusNoContent,
		Hidden:        true,
		// Deliberately no Security: workers are local subprocesses with no user identity. The
		// shared token below is what authenticates them.
	}, func(ctx context.Context, in *ingestEventInput) (*struct{}, error) {
		if subtle.ConstantTimeCompare([]byte(in.Token), []byte(deps.Cfg.Telemetry.Token)) != 1 {
			return nil, huma.Error401Unauthorized("invalid telemetry token")
		}

		id, eventType, subject, occurredAt, data := normalizeCloudEvent(in)
		if id == "" || !storedEventTypes[eventType] {
			return nil, nil
		}

		canonical, attempt := canonicalizeEventData(data)
		truncated := false
		if max := deps.Cfg.Telemetry.MaxEventBytes; max > 0 && len(canonical) > max {
			canonical = truncatedPayload(canonical, max)
			truncated = true
		}

		event := models.ExecutionEvent{
			WorkflowExecutionID: id,
			EventType:           eventType,
			TaskName:            subject,
			Attempt:             attempt,
			OccurredAt:          occurredAt,
			ReceivedAt:          time.Now(),
			Data:                canonical,
			Truncated:           truncated,
			DedupeKey:           dedupeKeyFor(id, eventType, subject, canonical),
		}
		if res, ok := deps.Resolver.Lookup(id); ok {
			event.ExecutionID = res.ExecutionID
			event.RootExecutionID = res.RootExecutionID
			event.ScopePath = res.ScopePath
		}

		insert := deps.DB.WithContext(ctx).
			Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "dedupe_key"}}, DoNothing: true}).
			Create(&event)
		if insert.Error != nil {
			return nil, huma.Error500InternalServerError("failed to store the event", insert.Error)
		}
		if insert.RowsAffected == 0 {
			return nil, nil // a replay of something already recorded
		}

		if event.ExecutionID != "" {
			deps.Bus.Publish(event.ExecutionID, event)
		}
		deps.Resolver.Enqueue(event.Seq)
		return nil, nil
	})
}

// normalizeCloudEvent reads the envelope from wherever this delivery put it — ce-* headers in
// binary mode, the body itself in structured mode.
func normalizeCloudEvent(in *ingestEventInput) (id, eventType, subject string, occurredAt time.Time, data []byte) {
	id, eventType, subject, data = in.ID, in.Type, in.Subject, in.RawBody
	rawTime := in.Time

	if id == "" && strings.HasPrefix(in.ContentType, "application/cloudevents+json") {
		var envelope structuredEnvelope
		if err := json.Unmarshal(in.RawBody, &envelope); err == nil {
			id, eventType, subject, rawTime, data = envelope.ID, envelope.Type, envelope.Subject, envelope.Time, envelope.Data
		}
	}

	eventType = strings.TrimPrefix(eventType, "dev.zigflow.")

	occurredAt = time.Now()
	if parsed, err := time.Parse(time.RFC3339Nano, rawTime); err == nil {
		occurredAt = parsed
	}
	return id, eventType, subject, occurredAt, data
}

// canonicalizeEventData re-marshals the payload so byte-identical content always produces
// byte-identical bytes — Go sorts map keys on marshal — which is what makes content-hash
// deduplication of replayed events reliable. It also lifts out `attempt` for cheap querying.
func canonicalizeEventData(raw []byte) (canonical []byte, attempt int) {
	if len(raw) == 0 {
		return nil, 0
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return raw, 0
	}
	if n, ok := decoded["attempt"].(float64); ok {
		attempt = int(n)
	}
	if encoded, err := json.Marshal(decoded); err == nil {
		return encoded, attempt
	}
	return raw, attempt
}

// dedupeKeyFor identifies an event by its content rather than its arrival. The CloudEvent's
// timestamp is deliberately excluded: zigflow re-stamps it on every replay, which would defeat
// the whole mechanism.
//
// Workflow determinism means a replayed task.started/task.completed is byte-identical, so
// replays collapse exactly; separate `for` iterations live in separate child workflow executions
// so their ids differ; retries differ by `attempt`. The one deliberate over-collapse is a
// switch-`then` back-jump re-running the same task with identical state — that second run is
// swallowed, which is preferable to storing every replay of a long workflow.
func dedupeKeyFor(id, eventType, subject string, data []byte) string {
	sum := sha256.New()
	for _, part := range []string{id, eventType, subject} {
		sum.Write([]byte(part))
		sum.Write([]byte{0})
	}
	sum.Write(data)
	return hex.EncodeToString(sum.Sum(nil))
}

// truncatedPayload replaces an oversized payload with a marker plus a readable prefix. zigflow
// puts the entire workflow state in every event, so without this a few long runs would dominate
// the database.
func truncatedPayload(data []byte, max int) []byte {
	prefix := string(data)
	if len(prefix) > max {
		prefix = prefix[:max]
	}
	encoded, err := json.Marshal(map[string]any{
		"_truncated": true,
		"_bytes":     len(data),
		"_prefix":    prefix,
	})
	if err != nil {
		return []byte(fmt.Sprintf(`{"_truncated":true,"_bytes":%d}`, len(data)))
	}
	return encoded
}
