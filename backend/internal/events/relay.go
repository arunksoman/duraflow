package events

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"duraflow/backend/internal/coord"
	"duraflow/backend/internal/models"
)

// ResyncEventType wakes a stream after the relay reconnected, so it can ask its client to re-read
// the event log from the last sequence it has. Never stored.
const ResyncEventType = "__duraflow.resync"

// Relay is a Bus shared by every copy of the backend. Publishing sends only a reference to the
// stored event (its execution id and sequence number) through the notifier; each copy that has a
// stream open for that execution reads the row and hands it to its local Broker. Events that are
// never stored, such as the terminal marker, travel whole because they are tiny.
type Relay struct {
	local    *Broker
	notifier coord.Notifier
	load     func(ctx context.Context, seq uint64) (models.ExecutionEvent, error)
}

type relayMessage struct {
	ExecutionID string    `json:"e"`
	Seq         uint64    `json:"s,omitempty"`
	EventType   string    `json:"t,omitempty"`
	OccurredAt  time.Time `json:"o,omitzero"`
}

// NewRelay wires a relay to a notifier. load reads one stored event by sequence number.
func NewRelay(notifier coord.Notifier, load func(ctx context.Context, seq uint64) (models.ExecutionEvent, error)) *Relay {
	r := &Relay{local: NewBroker(), notifier: notifier, load: load}
	notifier.Listen(coord.ChannelEvents, r.receive)
	notifier.OnReconnect(func() {
		r.local.MarkAllLagged(models.ExecutionEvent{EventType: ResyncEventType, ReceivedAt: time.Now()})
	})
	return r
}

func (r *Relay) Subscribe(executionID string) *Subscription {
	return r.local.Subscribe(executionID)
}

func (r *Relay) Publish(executionID string, ev models.ExecutionEvent) {
	if executionID == "" {
		return
	}
	msg := relayMessage{ExecutionID: executionID, Seq: ev.Seq}
	if ev.Seq == 0 {
		msg.EventType = ev.EventType
		msg.OccurredAt = ev.OccurredAt
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.notifier.Notify(ctx, coord.ChannelEvents, string(payload)); err != nil {
		// Streams on this copy still get it; streams elsewhere catch up on their next refetch.
		log.Printf("[events] relaying event for %s: %v", executionID, err)
		r.local.Publish(executionID, ev)
	}
}

func (r *Relay) receive(payload string) {
	var msg relayMessage
	if err := json.Unmarshal([]byte(payload), &msg); err != nil || msg.ExecutionID == "" {
		return
	}
	if !r.local.HasSubscribers(msg.ExecutionID) {
		return
	}
	if msg.Seq == 0 {
		r.local.Publish(msg.ExecutionID, models.ExecutionEvent{
			ExecutionID:         msg.ExecutionID,
			WorkflowExecutionID: msg.ExecutionID,
			EventType:           msg.EventType,
			OccurredAt:          msg.OccurredAt,
			ReceivedAt:          time.Now(),
		})
		return
	}
	// Read off the notifier goroutine: a slow read must not delay every other copy's messages.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ev, err := r.load(ctx, msg.Seq)
		if err != nil {
			return
		}
		r.local.Publish(msg.ExecutionID, ev)
	}()
}
