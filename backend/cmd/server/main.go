package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"duraflow/backend/internal/app"
	"duraflow/backend/internal/config"
)

// main starts whichever roles DURAFLOW_ROLES names (api and worker by default) and runs until
// SIGINT or SIGTERM. See internal/app for what each role does.
func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg)
	if err != nil {
		log.Fatalf("%v", err)
	}
	if err := a.Run(ctx); err != nil {
		log.Fatalf("server: %v", err)
	}
	log.Println("shut down")
}
