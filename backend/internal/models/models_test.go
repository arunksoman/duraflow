package models

import "testing"

func TestBaseBeforeCreate(t *testing.T) {
	var b Base
	if err := b.BeforeCreate(nil); err != nil || len(b.ID) != 36 {
		t.Fatalf("want generated UUID, got %q (%v)", b.ID, err)
	}
	b = Base{ID: "fixed"}
	_ = b.BeforeCreate(nil)
	if b.ID != "fixed" {
		t.Errorf("existing ID overwritten: %q", b.ID)
	}
}

func TestExecutionTriggerValid(t *testing.T) {
	for _, tr := range []ExecutionTrigger{TriggerManual, TriggerScheduled, TriggerBackfill} {
		if !tr.Valid() {
			t.Errorf("%q should be valid", tr)
		}
	}
	for _, tr := range []ExecutionTrigger{"", "cron", "MANUAL"} {
		if tr.Valid() {
			t.Errorf("%q should be invalid", tr)
		}
	}
}
