package models

import "time"

type WorkerStatus string

const (
	WorkerOnline   WorkerStatus = "online"
	WorkerOffline  WorkerStatus = "offline"
	WorkerDraining WorkerStatus = "draining"
)

type Worker struct {
	Base
	Identity        string       `gorm:"not null" json:"identity"`
	TaskQueue       string       `gorm:"not null" json:"taskQueue"`
	Status          WorkerStatus `gorm:"not null;default:offline" json:"status"`
	LastHeartbeatAt time.Time    `json:"lastHeartbeatAt"`
}
