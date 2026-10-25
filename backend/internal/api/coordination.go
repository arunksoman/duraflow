package api

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"duraflow/backend/internal/coord"
)

// The helpers below are how a request on one copy reaches work owned by another. With no Notifier
// (tests, and any caller that wires none) they act locally, which is also what the single-process
// mode's in-memory notifier ends up doing.

// fallbackLocks serves Deps without a Locker, so single-process callers need not wire one.
var fallbackLocks = coord.NewMemory()

func (d *Deps) locker() coord.Locker {
	if d.Locks != nil {
		return d.Locks
	}
	return fallbackLocks
}

// WatchExecution makes sure something waits for a running execution to close and records the
// outcome. Watchers run on the jobs leader only, so with a notifier the request goes there; the
// leader's periodic sweep catches anything a lost notification misses.
func (d *Deps) WatchExecution(executionID string) {
	if d.Notifier == nil {
		go watchTerminal(d, executionID)
		return
	}
	d.notify(coord.ChannelWatch, executionID)
}

// workflowsChanged tells every worker pool to re-read its task queues and registrations now,
// rather than on its next refresh tick.
func (d *Deps) workflowsChanged() {
	if d.Notifier != nil {
		d.notify(coord.ChannelWorkflows, "")
	}
}

// forgetRuns drops cached event resolutions for deleted run trees on every copy, so a late event
// can't be attributed to a run that no longer exists.
func (d *Deps) forgetRuns(rootExecutionIDs []string) {
	if len(rootExecutionIDs) == 0 {
		return
	}
	if d.Notifier == nil {
		d.Resolver.Forget(rootExecutionIDs...)
		return
	}
	payload, err := json.Marshal(rootExecutionIDs)
	if err != nil {
		return
	}
	d.notify(coord.ChannelForget, string(payload))
}

func (d *Deps) notify(channel, payload string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.Notifier.Notify(ctx, channel, payload); err != nil {
		log.Printf("[coord] notifying %s: %v", channel, err)
	}
}

// ForgetPayload decodes a ChannelForget payload, for main's listener.
func ForgetPayload(payload string) []string {
	var ids []string
	_ = json.Unmarshal([]byte(payload), &ids)
	return ids
}
