// Package coord is what lets several copies of the backend share work: a broadcast channel between
// copies, a leader lock for jobs that must run exactly once, and named mutual-exclusion locks.
//
// Each piece has two implementations. The in-memory one serves the default single-process mode
// (SQLite, one copy). The Postgres one uses LISTEN/NOTIFY and advisory locks, so a multi-copy
// deployment needs nothing besides the database it already has.
package coord

import (
	"context"
	"hash/fnv"
	"sync"
)

// Channels used between copies. Payloads are small JSON documents, never event bodies.
const (
	// ChannelEvents carries "an execution event was stored or resolved" (see events.Relay).
	ChannelEvents = "duraflow_events"
	// ChannelWorkflows carries "a workflow's DSL changed": worker pools refresh their queues.
	ChannelWorkflows = "duraflow_workflows"
	// ChannelWatch carries "start watching this execution for completion": only the leader acts.
	ChannelWatch = "duraflow_watch"
	// ChannelForget carries "these run trees were deleted": every copy drops cached resolutions.
	ChannelForget = "duraflow_forget"
)

// Notifier broadcasts small messages to every copy, including the sender.
type Notifier interface {
	// Notify sends payload on channel. Delivery is at-most-once: a copy that is reconnecting misses
	// it, which is why every consumer also has a periodic fallback.
	Notify(ctx context.Context, channel, payload string) error
	// Listen registers a handler. Handlers run on the notifier's goroutine and must not block.
	Listen(channel string, handler func(payload string))
	// OnReconnect registers a handler called after the notifier lost its connection and got it
	// back, so consumers can re-read whatever they may have missed.
	OnReconnect(handler func())
}

// Elector runs a job on exactly one copy at a time.
type Elector interface {
	// Run blocks until ctx is done. Whenever this copy holds leadership it calls lead with a
	// context that is cancelled as soon as leadership is lost.
	Run(ctx context.Context, lead func(ctx context.Context))
}

// Locker provides named mutual exclusion across copies.
type Locker interface {
	// Lock blocks until key is held and returns the function that releases it.
	Lock(ctx context.Context, key string) (unlock func(), err error)
}

// Memory is the single-process implementation of all three interfaces.
type Memory struct {
	mu        sync.RWMutex
	handlers  map[string][]func(string)
	stripes   [64]sync.Mutex
	reconnect []func()
}

func NewMemory() *Memory {
	return &Memory{handlers: map[string][]func(string){}}
}

func (m *Memory) Notify(_ context.Context, channel, payload string) error {
	m.mu.RLock()
	handlers := append([]func(string){}, m.handlers[channel]...)
	m.mu.RUnlock()
	for _, h := range handlers {
		h(payload)
	}
	return nil
}

func (m *Memory) Listen(channel string, handler func(string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handlers[channel] = append(m.handlers[channel], handler)
}

func (m *Memory) OnReconnect(handler func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reconnect = append(m.reconnect, handler)
}

// Run makes the only copy the leader for as long as it runs.
func (m *Memory) Run(ctx context.Context, lead func(ctx context.Context)) {
	lead(ctx)
	<-ctx.Done()
}

func (m *Memory) Lock(ctx context.Context, key string) (func(), error) {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	mu := &m.stripes[h.Sum32()%uint32(len(m.stripes))]
	locked := make(chan struct{})
	go func() {
		mu.Lock()
		close(locked)
	}()
	select {
	case <-locked:
		return mu.Unlock, nil
	case <-ctx.Done():
		// The goroutine still takes the lock eventually; release it as soon as it does.
		go func() {
			<-locked
			mu.Unlock()
		}()
		return nil, ctx.Err()
	}
}
