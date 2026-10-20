package events

import (
	"testing"

	"duraflow/backend/internal/models"
)

func TestPublishReachesOnlyThatExecution(t *testing.T) {
	b := NewBroker()
	a1 := b.Subscribe("a")
	a2 := b.Subscribe("a")
	other := b.Subscribe("b")
	defer a1.Close()
	defer a2.Close()
	defer other.Close()

	b.Publish("a", models.ExecutionEvent{Seq: 7})
	for i, s := range []*Subscription{a1, a2} {
		select {
		case ev := <-s.C:
			if ev.Seq != 7 {
				t.Errorf("sub %d got seq %d", i, ev.Seq)
			}
		default:
			t.Errorf("sub %d got nothing", i)
		}
	}
	select {
	case ev := <-other.C:
		t.Errorf("other execution received %+v", ev)
	default:
	}
}

func TestPublishIgnoresEmptyExecutionAndUnwatched(t *testing.T) {
	b := NewBroker()
	s := b.Subscribe("")
	defer s.Close()
	b.Publish("", models.ExecutionEvent{Seq: 1})
	b.Publish("nobody", models.ExecutionEvent{Seq: 2})
	if len(s.C) != 0 {
		t.Error("empty execution id should never be delivered")
	}
}

func TestCloseUnsubscribes(t *testing.T) {
	b := NewBroker()
	keep := b.Subscribe("a")
	defer keep.Close()
	s := b.Subscribe("a")
	s.Close()
	s.Close() // idempotent
	b.Publish("a", models.ExecutionEvent{Seq: 1})
	if len(s.C) != 0 {
		t.Error("closed subscription still received")
	}
	if len(keep.C) != 1 {
		t.Error("closing one subscription affected another")
	}
	keep.Close()
	if len(b.subs) != 0 {
		t.Errorf("empty subscriber set not pruned: %v", b.subs)
	}
}

func TestSlowSubscriberIsFlaggedLaggedNotBlocking(t *testing.T) {
	b := NewBroker()
	s := b.Subscribe("a")
	defer s.Close()
	for i := 0; i < subscriberBuffer+5; i++ {
		b.Publish("a", models.ExecutionEvent{Seq: uint64(i)})
	}
	if !s.Lagged() {
		t.Fatal("overflow should flag lagged")
	}
	if len(s.C) != subscriberBuffer {
		t.Errorf("buffer holds %d, want %d", len(s.C), subscriberBuffer)
	}
	s.ResetLagged()
	if s.Lagged() {
		t.Error("ResetLagged did not clear")
	}
}
