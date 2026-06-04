import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, Text, Integer, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

class AppSettings(Base):
    __tablename__ = "app_settings"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    app_name: Mapped[str] = mapped_column(String, default="FutureSign Multi-App")
    app_logo_url: Mapped[str | None] = mapped_column(String, nullable=True)
    branding_text: Mapped[str] = mapped_column(String, default="Empowering Digital Enterprise")
    sub_text: Mapped[str] = mapped_column(String, default="Experience the next generation of multi-application management with our secure, unified platform.")
    theme: Mapped[str] = mapped_column(String, default="minimalist-slate")
    dark_mode: Mapped[str] = mapped_column(String, default="system")
    timezone_display: Mapped[str] = mapped_column(String, default="Asia/Bangkok")
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # LINE OA settings (Configurable via admin panel, falls back to env vars if null)
    line_channel_access_token: Mapped[str | None] = mapped_column(String, nullable=True)
    line_channel_secret: Mapped[str | None] = mapped_column(String, nullable=True)
    line_liff_id: Mapped[str | None] = mapped_column(String, nullable=True)

class LocalRole(Base):
    __tablename__ = "local_roles"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_system_role: Mapped[bool] = mapped_column(Boolean, default=False)

class LocalUser(Base):
    __tablename__ = "local_users"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[str] = mapped_column(String, unique=True)
    full_name: Mapped[str] = mapped_column(String)
    department: Mapped[str] = mapped_column(String)
    division: Mapped[str] = mapped_column(String)
    company: Mapped[str] = mapped_column(String)
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_roles.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    deprovisioned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class LocalMenu(Base):
    __tablename__ = "local_menus"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String, unique=True)
    label: Mapped[str] = mapped_column(String)
    path: Mapped[str] = mapped_column(String)
    icon: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("local_menus.id"), nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

class RoleMenuPermission(Base):
    __tablename__ = "role_menu_permissions"
    
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_roles.id"), primary_key=True)
    menu_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_menus.id"), primary_key=True)
    can_access: Mapped[bool] = mapped_column(Boolean, default=True)

class LineBinding(Base):
    __tablename__ = "line_bindings"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    line_user_id: Mapped[str] = mapped_column(String)
    employee_id: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="PENDING") # PENDING, APPROVED, REJECTED, REVOKED
    approved_by: Mapped[str | None] = mapped_column(String, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    revoke_reason: Mapped[str | None] = mapped_column(String, nullable=True)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    action: Mapped[str] = mapped_column(String) # e.g., "AUTH_LOGIN_SUCCESS"
    details: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_id: Mapped[str] = mapped_column(String) # employee_id
    ip_address: Mapped[str | None] = mapped_column(String, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
