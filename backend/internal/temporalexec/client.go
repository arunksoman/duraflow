// Package temporalexec is the backend's Temporal client + Zigflow worker-process manager.
// It is the only place that knows how to talk to Temporal or spawn `zigflow run`.
package temporalexec

import (
	"fmt"
	"sync"

	"go.temporal.io/sdk/client"
)

// LazyClient dials Temporal on first use rather than at startup, so the backend still boots
// when Temporal isn't up yet (common in dev — it just fails the first execution attempt).
type LazyClient struct {
	address string

	mu     sync.Mutex
	client client.Client
}

func NewLazyClient(address string) *LazyClient {
	return &LazyClient{address: address}
}

func (l *LazyClient) Get() (client.Client, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.client != nil {
		return l.client, nil
	}

	c, err := client.Dial(client.Options{HostPort: l.address})
	if err != nil {
		return nil, fmt.Errorf("connecting to temporal at %s: %w", l.address, err)
	}
	l.client = c
	return c, nil
}

func (l *LazyClient) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.client != nil {
		l.client.Close()
		l.client = nil
	}
}
