package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"duraflow/backend/internal/models"
)

// postEvent delivers a CloudEvent the way a zigflow worker does: binary mode, ce-* headers.
func (e *testEnv) postEvent(token, id, eventType, subject, ceTime, body string) response {
	e.t.Helper()
	return e.request(http.MethodPost, "/api/internal/zigflow/events", body,
		"Authorization", "",
		"X-Duraflow-Token", token,
		"ce-id", id,
		"ce-type", eventType,
		"ce-source", "zigflow",
		"ce-subject", subject,
		"ce-time", ceTime,
		"ce-specversion", "1.0",
	)
}

func (e *testEnv) storedEvents() []models.ExecutionEvent {
	e.t.Helper()
	var evs []models.ExecutionEvent
	e.deps.DB.Order("seq").Find(&evs)
	return evs
}

func TestIngestRejectsBadToken(t *testing.T) {
	env := newTestEnv(t)
	for _, token := range []string{"", "wrong"} {
		if resp := env.postEvent(token, "wf", "dev.zigflow.task.started", "a", "", `{}`); resp.Status != http.StatusUnauthorized {
			t.Errorf("token %q: %d", token, resp.Status)
		}
	}
	if n := len(env.storedEvents()); n != 0 {
		t.Errorf("stored %d events", n)
	}
}

func TestIngestStoresAndDeduplicates(t *testing.T) {
	env := newTestEnv(t)
	occurred := "2026-04-01T10:00:00.123456789Z"

	resp := env.postEvent(testTelemetryToken, "wf-1", "dev.zigflow.task.started", "fetch", occurred,
		`{"state":{"b":2,"a":1},"attempt":2}`)
	if resp.Status != http.StatusNoContent {
		t.Fatalf("status %d: %s", resp.Status, resp.Body)
	}
	evs := env.storedEvents()
	if len(evs) != 1 {
		t.Fatalf("stored %d", len(evs))
	}
	ev := evs[0]
	if ev.WorkflowExecutionID != "wf-1" || ev.EventType != models.EventTaskStarted || ev.TaskName != "fetch" ||
		ev.Attempt != 2 || ev.ExecutionID != "" || ev.Truncated {
		t.Errorf("stored: %+v", ev)
	}
	if want, _ := time.Parse(time.RFC3339Nano, occurred); !ev.OccurredAt.Equal(want) {
		t.Errorf("occurredAt %v", ev.OccurredAt)
	}
	if string(ev.Data) != `{"attempt":2,"state":{"a":1,"b":2}}` {
		t.Errorf("payload should be canonical: %s", ev.Data)
	}

	// A replay re-stamps the time and reorders keys, but is the same event.
	env.postEvent(testTelemetryToken, "wf-1", "dev.zigflow.task.started", "fetch", "2026-04-01T11:00:00Z",
		`{"attempt":2,"state":{"a":1,"b":2}}`)
	// A retry differs by attempt, so it's kept.
	env.postEvent(testTelemetryToken, "wf-1", "dev.zigflow.task.started", "fetch", "", `{"attempt":3,"state":{"a":1,"b":2}}`)
	if n := len(env.storedEvents()); n != 2 {
		t.Errorf("want the replay collapsed and the retry kept, have %d events", n)
	}
}

func TestIngestIgnoresUnknownAndAnonymousEvents(t *testing.T) {
	env := newTestEnv(t)
	env.postEvent(testTelemetryToken, "wf", "dev.zigflow.something.new", "a", "", `{}`)
	env.postEvent(testTelemetryToken, "", "dev.zigflow.task.started", "a", "", `{}`)
	if n := len(env.storedEvents()); n != 0 {
		t.Errorf("stored %d", n)
	}
}

func TestIngestStructuredMode(t *testing.T) {
	env := newTestEnv(t)
	body := `{"specversion":"1.0","id":"wf-s","type":"dev.zigflow.task.completed","source":"z","subject":"save","time":"bad-time","data":{"output":[1]}}`
	req, _ := http.NewRequest(http.MethodPost, env.server.URL+"/api/internal/zigflow/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/cloudevents+json; charset=utf-8")
	req.Header.Set("X-Duraflow-Token", testTelemetryToken)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", r.StatusCode)
	}

	evs := env.storedEvents()
	if len(evs) != 1 {
		t.Fatalf("stored %d", len(evs))
	}
	if evs[0].WorkflowExecutionID != "wf-s" || evs[0].EventType != models.EventTaskCompleted ||
		evs[0].TaskName != "save" || string(evs[0].Data) != `{"output":[1]}` {
		t.Errorf("stored: %+v", evs[0])
	}
	// An unparseable time falls back to "now".
	if time.Since(evs[0].OccurredAt) > time.Minute {
		t.Errorf("occurredAt %v", evs[0].OccurredAt)
	}
}

func TestIngestTruncatesLargePayloads(t *testing.T) {
	env := newTestEnv(t)
	big := `{"state":"` + strings.Repeat("x", 10_000) + `"}`
	env.postEvent(testTelemetryToken, "wf", "dev.zigflow.task.completed", "a", "", big)

	evs := env.storedEvents()
	if len(evs) != 1 || !evs[0].Truncated {
		t.Fatalf("stored: %+v", evs)
	}
	var marker map[string]any
	if err := json.Unmarshal(evs[0].Data, &marker); err != nil {
		t.Fatal(err)
	}
	if marker["_truncated"] != true || marker["_bytes"] != float64(len(big)) || len(marker["_prefix"].(string)) != 4096 {
		t.Errorf("marker: _truncated=%v _bytes=%v prefix len %d", marker["_truncated"], marker["_bytes"], len(marker["_prefix"].(string)))
	}
}

func TestIngestStampsKnownExecutionAndPublishes(t *testing.T) {
	env := newTestEnv(t)
	ex := env.seedExecution(env.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionRunning))
	if _, err := env.deps.Resolver.Resolve(t.Context(), ex.ID); err != nil {
		t.Fatal(err)
	}
	sub := env.deps.Bus.Subscribe(ex.ID)
	defer sub.Close()

	env.postEvent(testTelemetryToken, ex.ID, "dev.zigflow.workflow.started", "", "", `{}`)

	evs := env.storedEvents()
	if len(evs) != 1 || evs[0].ExecutionID != ex.ID || evs[0].RootExecutionID != ex.ID {
		t.Fatalf("stored: %+v", evs)
	}
	select {
	case ev := <-sub.C:
		if ev.Seq != evs[0].Seq {
			t.Errorf("published %+v", ev)
		}
	case <-time.After(time.Second):
		t.Error("known execution's event not published inline")
	}
}

func TestCanonicalizeEventData(t *testing.T) {
	if got, attempt := canonicalizeEventData(nil); got != nil || attempt != 0 {
		t.Errorf("empty: %s %d", got, attempt)
	}
	if got, _ := canonicalizeEventData([]byte("not json")); string(got) != "not json" {
		t.Errorf("non-JSON should pass through: %s", got)
	}
	if got, _ := canonicalizeEventData([]byte(`[1,2]`)); string(got) != `[1,2]` {
		t.Errorf("non-object should pass through: %s", got)
	}
	a, _ := canonicalizeEventData([]byte(`{"b":1, "a":{"y":2,"x":1}}`))
	b, _ := canonicalizeEventData([]byte(`{"a":{"x":1,"y":2},"b":1}`))
	if !bytes.Equal(a, b) {
		t.Errorf("same content, different bytes: %s vs %s", a, b)
	}
	if _, attempt := canonicalizeEventData([]byte(`{"attempt":"3"}`)); attempt != 0 {
		t.Error("non-numeric attempt should be ignored")
	}
}

func TestDedupeKeyFor(t *testing.T) {
	base := dedupeKeyFor("id", "task.started", "a", []byte(`{}`))
	if base != dedupeKeyFor("id", "task.started", "a", []byte(`{}`)) {
		t.Error("not deterministic")
	}
	for name, other := range map[string]string{
		"id":      dedupeKeyFor("id2", "task.started", "a", []byte(`{}`)),
		"type":    dedupeKeyFor("id", "task.completed", "a", []byte(`{}`)),
		"subject": dedupeKeyFor("id", "task.started", "b", []byte(`{}`)),
		"data":    dedupeKeyFor("id", "task.started", "a", []byte(`{"x":1}`)),
		// Field boundaries matter: "ab"+"c" must not collide with "a"+"bc".
		"boundary": dedupeKeyFor("i", "dtask.started", "a", []byte(`{}`)),
	} {
		if other == base {
			t.Errorf("changing %s did not change the key", name)
		}
	}
}

func TestTruncatedPayloadSmallMax(t *testing.T) {
	out := truncatedPayload([]byte("abcdef"), 3)
	var marker map[string]any
	if err := json.Unmarshal(out, &marker); err != nil {
		t.Fatal(err)
	}
	if marker["_prefix"] != "abc" || marker["_bytes"] != float64(6) {
		t.Errorf("marker: %v", marker)
	}
}
