package events

import (
	"context"
	"errors"
	"testing"
	"time"

	"duraflow/backend/internal/coord"
	"duraflow/backend/internal/models"
)

func TestRelayDeliversStoredEventsByReference(t *testing.T) {
	notifier := coord.NewMemory()
	stored := map[uint64]models.ExecutionEvent{7: {Seq: 7, ExecutionID: "run-1", TaskName: "greet"}}
	load := func(_ context.Context, seq uint64) (models.ExecutionEvent, error) {
		ev, ok := stored[seq]
		if !ok {
			return models.ExecutionEvent{}, errors.New("missing")
		}
		return ev, nil
	}
	// Two copies sharing one notifier: publishing on one reaches streams on the other.
	sender, receiver := NewRelay(notifier, load), NewRelay(notifier, load)

	sub := receiver.Subscribe("run-1")
	defer sub.Close()
	sender.Publish("run-1", models.ExecutionEvent{Seq: 7, ExecutionID: "run-1"})

	select {
	case ev := <-sub.C:
		if ev.TaskName != "greet" {
			t.Errorf("the receiver should read the stored row, got %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event never relayed")
	}

	// Unstored markers travel whole.
	sender.Publish("run-1", models.ExecutionEvent{ExecutionID: "run-1", EventType: "__duraflow.terminal"})
	select {
	case ev := <-sub.C:
		if ev.EventType != "__duraflow.terminal" {
			t.Errorf("marker: %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("marker never relayed")
	}
}

func TestRelayResyncsStreamsAfterReconnect(t *testing.T) {
	notifier := &reconnectingNotifier{Memory: coord.NewMemory()}
	relay := NewRelay(notifier, func(context.Context, uint64) (models.ExecutionEvent, error) {
		return models.ExecutionEvent{}, nil
	})
	sub := relay.Subscribe("run-1")
	defer sub.Close()

	notifier.reconnected()
	select {
	case ev := <-sub.C:
		if ev.EventType != ResyncEventType || !sub.Lagged() {
			t.Errorf("after a reconnect the stream should be told to refetch: %+v lagged=%v", ev, sub.Lagged())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream never woken after reconnect")
	}
}

type reconnectingNotifier struct {
	*coord.Memory
	handlers []func()
}

func (n *reconnectingNotifier) OnReconnect(h func()) { n.handlers = append(n.handlers, h) }

func (n *reconnectingNotifier) reconnected() {
	for _, h := range n.handlers {
		h()
	}
}
