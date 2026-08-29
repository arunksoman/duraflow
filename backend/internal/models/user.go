package models

// Role mirrors the frontend's Role union in src/lib/types/index.ts.
type Role string

const (
	RoleAdmin    Role = "admin"
	RoleDesigner Role = "designer"
	RoleBusiness Role = "business"
)

type User struct {
	Base
	Email        string `gorm:"uniqueIndex;not null" json:"email"`
	PasswordHash string `gorm:"not null" json:"-"`
	Name         string `json:"name"`
	Role         Role   `gorm:"not null;default:designer" json:"role"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
}
