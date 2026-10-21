package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestHashAndCheckPassword(t *testing.T) {
	hash, err := HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "s3cret" || !strings.HasPrefix(hash, "$2") {
		t.Fatalf("hash does not look like bcrypt: %q", hash)
	}
	if !CheckPassword(hash, "s3cret") {
		t.Error("correct password rejected")
	}
	if CheckPassword(hash, "wrong") {
		t.Error("wrong password accepted")
	}
	if CheckPassword("not-a-hash", "s3cret") {
		t.Error("garbage hash accepted")
	}
}

func TestIssueAndVerifyToken(t *testing.T) {
	before := time.Now()
	token, expiresAt, err := IssueToken("secret", "user-1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if expiresAt.Before(before.Add(time.Hour)) || expiresAt.After(time.Now().Add(time.Hour)) {
		t.Errorf("expiresAt %v not ~1h from now", expiresAt)
	}
	got, err := VerifyToken("secret", token)
	if err != nil || got != "user-1" {
		t.Fatalf("VerifyToken = (%q, %v), want (user-1, nil)", got, err)
	}
}

func TestVerifyTokenRejects(t *testing.T) {
	valid, _, _ := IssueToken("secret", "u", time.Hour)
	expired, _, _ := IssueToken("secret", "u", -time.Minute)
	none := jwt.NewWithClaims(jwt.SigningMethodNone, Claims{UserID: "u"})
	unsigned, _ := none.SignedString(jwt.UnsafeAllowNoneSignatureType)

	cases := map[string]struct{ secret, token string }{
		"wrong secret": {"other", valid},
		"expired":      {"secret", expired},
		"garbage":      {"secret", "not.a.jwt"},
		"empty":        {"secret", ""},
		"alg none":     {"secret", unsigned},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if id, err := VerifyToken(c.secret, c.token); err == nil {
				t.Errorf("accepted, user %q", id)
			}
		})
	}
}
