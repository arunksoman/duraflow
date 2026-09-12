// Package events fans freshly-ingested execution events out to whoever is watching a run —
// an in-process pub/sub with no persistence of its own. Durability lives in the database; this
// only exists so a browser watching a live run doesn't have to poll.
package events

import (
	"sync"

	"duraflow/backend/internal/models"
)

const subscriberBuffer = 256

type subscriber struct {
	ch     chan models.ExecutionEvent
	lagged bool
	mu     sync.Mutex
}

// Broker routes published events to every subscriber of the same execution.
type Broker struct {
	mu     sync.RWMutex
	nextID int64
	subs   map[string]map[int64]*subscriber
}

func NewBroker() *Broker {
	return &Broker{subs: map[string]map[int64]*subscriber{}}
}

// Subscription is one watcher's view of a run. Lagged reports whether the broker had to drop
// events because this watcher fell behind — the watcher should then re-read from the database
// rather than assume it saw everything.
type Subscription struct {
	C      <-chan models.ExecutionEvent
	sub    *subscriber
	cancel func()
}

func (s *Subscription) Lagged() bool {
	s.sub.mu.Lock()
	defer s.sub.mu.Unlock()
	return s.sub.lagged
}

func (s *Subscription) ResetLagged() {
	s.sub.mu.Lock()
	s.sub.lagged = false
	s.sub.mu.Unlock()
}

func (s *Subscription) Close() { s.cancel() }

// Subscribe starts receiving events for one execution. Always Close the subscription.
func (b *Broker) Subscribe(executionID string) *Subscription {
	sub := &subscriber{ch: make(chan models.ExecutionEvent, subscriberBuffer)}

	b.mu.Lock()
	b.nextID++
	id := b.nextID
	if b.subs[executionID] == nil {
		b.subs[executionID] = map[int64]*subscriber{}
	}
	b.subs[executionID][id] = sub
	b.mu.Unlock()

	return &Subscription{
		C:   sub.ch,
		sub: sub,
		cancel: func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if set, ok := b.subs[executionID]; ok {
				delete(set, id)
				if len(set) == 0 {
					delete(b.subs, executionID)
				}
			}
		},
	}
}

// Publish delivers an event to that execution's subscribers. It never blocks: a subscriber whose
// buffer is full is flagged as lagged and the event is dropped for it alone, because the
// alternative — blocking — would stall the resolver goroutine that feeds every run at once.
func (b *Broker) Publish(executionID string, ev models.ExecutionEvent) {
	if executionID == "" {
		return
	}

	b.mu.RLock()
	targets := make([]*subscriber, 0, len(b.subs[executionID]))
	for _, sub := range b.subs[executionID] {
		targets = append(targets, sub)
	}
	b.mu.RUnlock()

	for _, sub := range targets {
		select {
		case sub.ch <- ev:
		default:
			sub.mu.Lock()
			sub.lagged = true
			sub.mu.Unlock()
		}
	}
}
