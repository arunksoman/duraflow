package temporalexec

import (
	"testing"

	"duraflow/backend/internal/temporalexec/temporaltest"
)

func TestLazyClientUnreachable(t *testing.T) {
	c := NewLazyClient("127.0.0.1:1")
	defer c.Close()
	if _, err := c.Get(); err == nil {
		t.Fatal("dialing a closed port should fail")
	}
	// A failed dial is not cached: the next call tries again.
	if _, err := c.Get(); err == nil {
		t.Fatal("second dial should fail too")
	}
}

func TestStaticClientIsReturnedUntilClosed(t *testing.T) {
	fake := temporaltest.New()
	c := NewStaticClient(fake)
	got, err := c.Get()
	if err != nil || got != fake {
		t.Fatalf("Get = (%v, %v), want the wrapped client", got, err)
	}
	c.Close()
	c.Close() // closing twice is fine
	if c.client != nil {
		t.Error("Close should drop the client")
	}
}
