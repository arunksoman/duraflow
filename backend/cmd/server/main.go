package main

import (
	"log"

	"gorm.io/gorm"

	"duraflow/backend/internal/api"
	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/models"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	conn, err := db.Open(cfg.Database)
	if err != nil {
		log.Fatalf("database: %v", err)
	}

	if err := seedAdmin(cfg, conn); err != nil {
		log.Fatalf("seed admin: %v", err)
	}

	router := api.NewRouter(&api.Deps{Cfg: cfg, DB: conn})

	log.Printf("duraflow backend listening on %s (docs at %s/docs, api at %s)",
		cfg.Server.Addr(), cfg.Server.Addr(), cfg.Server.BasePath)
	if err := router.Start(cfg.Server.Addr()); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// seedAdmin creates the configured admin user on first boot if the users
// table is empty, so there's always a way to log in against a fresh database.
func seedAdmin(cfg *config.Config, conn *gorm.DB) error {
	var count int64
	if err := conn.Model(&models.User{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	hash, err := auth.HashPassword(cfg.SeedAdmin.Password)
	if err != nil {
		return err
	}

	admin := models.User{
		Email:        cfg.SeedAdmin.Email,
		PasswordHash: hash,
		Name:         cfg.SeedAdmin.Name,
		Role:         models.RoleAdmin,
	}
	if err := conn.Create(&admin).Error; err != nil {
		return err
	}

	log.Printf("seeded admin user %s (change the password after first login)", admin.Email)
	return nil
}
