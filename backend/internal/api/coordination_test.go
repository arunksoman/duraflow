package api

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

// sizeLimitedNotifier fails payloads Postgres would refuse and keeps the ones it would send.
type sizeLimitedNotifier struct{ payloads []string }

func (n *sizeLimitedNotifier) Notify(_ context.Context, _, payload string) error {
	if len(payload) >= 8000 {
		return fmt.Errorf("payload string too long (%d bytes)", len(payload))
	}
	n.payloads = append(n.payloads, payload)
	return nil
}
func (n *sizeLimitedNotifier) Listen(string, func(string)) {}
func (n *sizeLimitedNotifier) OnReconnect(func())          {}

func TestForgetRunsFitsEveryIDIntoNotifyPayloads(t *testing.T) {
	ids := make([]string, executionDeleteBatch)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	notifier := &sizeLimitedNotifier{}
	(&Deps{Notifier: notifier}).forgetRuns(ids)

	var got []string
	for _, p := range notifier.payloads {
		got = append(got, ForgetPayload(p)...)
	}
	if len(got) != len(ids) {
		t.Fatalf("forgot %d of %d ids", len(got), len(ids))
	}
	for i := range ids {
		if got[i] != ids[i] {
			t.Fatalf("id %d: got %s, want %s", i, got[i], ids[i])
		}
	}
}
