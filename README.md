# FutureSign Corporate Web Template

> **Corporate-grade Web Application Template** สำหรับองค์กรในระบบนิเวศ FutureSign  
> พร้อม Authentication, Role & Permission, LINE OA Integration และ Admin Dashboard สำเร็จรูป

---

## ✨ Features

| Feature | คำอธิบาย |
|---------|---------|
| 🔐 **SSO Authentication** | Login ผ่าน FutureSign Core-API ศูนย์กลาง — ไม่ต้องสร้างระบบ login เอง |
| 👥 **Role & Permission** | Admin / Supervisor / User + กำหนด Menu Permission ได้ผ่าน UI |
| 📋 **Menu Management** | เพิ่ม/ซ่อน menu item ได้แบบ dynamic โดยไม่ต้องแก้โค้ด |
| ⚙️ **Admin Dashboard** | จัดการ Users, Roles, Menus, Settings รวมที่เดียว |
| 🎨 **Theme & Branding** | เปลี่ยนชื่อ App, Logo, Theme ได้จาก Admin UI |
| 💬 **LINE OA Integration** | ระบบ Binding LINE ↔ พนักงาน + Webhook + LIFF พร้อมใช้ |
| 📊 **Audit Logs** | บันทึก Activity ทุก action สำคัญในระบบ |
| 🐳 **Docker Ready** | Dockerfile + docker-compose ครบ พร้อม deploy ทันที |

---

## 🏗️ Tech Stack

### Backend
- **[FastAPI](https://fastapi.tiangolo.com/)** — Python async web framework
- **[SQLAlchemy 2.x](https://docs.sqlalchemy.org/)** — Async ORM
- **[PostgreSQL 16](https://www.postgresql.org/)** — Primary database
- **[Redis 7](https://redis.io/)** — Session / Cache
- **[asyncpg](https://github.com/MagicStack/asyncpg)** — Async PostgreSQL driver
- **[Uvicorn](https://www.uvicorn.org/)** — ASGI server

### Frontend
- **[Next.js 16](https://nextjs.org/)** — React framework (App Router)
- **[TypeScript](https://www.typescriptlang.org/)** — Type safety
- **[Tailwind CSS 4](https://tailwindcss.com/)** — Utility-first styling
- **[Lucide React](https://lucide.dev/)** — Icon library

---

## 📁 Project Structure

```
corp-temp/
├── backend/                    # FastAPI Application
│   ├── app/
│   │   ├── main.py             # App entrypoint, startup, middleware
│   │   ├── config.py           # Settings จาก .env (pydantic-settings)
│   │   ├── database.py         # SQLAlchemy engine & session
│   │   ├── models.py           # ORM Models
│   │   ├── seeds.py            # Initial data (Roles, Menus, Settings)
│   │   ├── dependencies.py     # Auth dependencies (get_current_user_id)
│   │   ├── core_api.py         # FutureSign Core-API HTTP client
│   │   ├── auth_router.py      # /api/v1/auth/*
│   │   ├── user_router.py      # /api/v1/users/*
│   │   ├── role_router.py      # /api/v1/roles/*
│   │   ├── menu_router.py      # /api/v1/menus/*
│   │   ├── settings_router.py  # /api/v1/settings/*
│   │   ├── line_router.py      # /api/v1/line/*
│   │   └── log_router.py       # /api/v1/logs/*
│   ├── .env.example            # ⭐ Template env — คัดลอกและแก้ไขก่อนใช้
│   ├── Dockerfile
│   └── requirements.txt
│
├── frontend/                   # Next.js Application
│   ├── src/app/
│   │   ├── dashboard/          # Protected pages (ต้อง login)
│   │   │   ├── page.tsx        # Dashboard home
│   │   │   ├── users/          # User Management
│   │   │   ├── roles/          # Role & Permission
│   │   │   ├── menus/          # Menu Management
│   │   │   ├── settings/       # System Settings (tabbed)
│   │   │   ├── line/           # LINE Approval Dashboard
│   │   │   └── logs/           # Activity Logs
│   │   ├── liff/
│   │   │   └── register/       # LIFF Page สำหรับพนักงาน bind LINE
│   │   ├── login/              # Login Page
│   │   └── layout.tsx
│   ├── .env.local.example      # ⭐ Template env — คัดลอกและแก้ไขก่อนใช้
│   ├── next.config.ts
│   ├── Dockerfile
│   └── package.json
│
├── docs/
│   ├── DEPLOY_GUIDE.md         # 🚀 คู่มือ Deploy (อ่านก่อน deploy)
│   ├── LINE_SETUP_GUIDE.md     # คู่มือตั้งค่า LINE OA Integration
│   └── CORE-API_INTEGRATION_GUIDE.md
│
├── docker-compose.yml          # Full-stack Docker setup
├── .gitignore
└── README.md
```

---

## 📋 How to Use as Template (การนำไปใช้งานเพื่อเริ่มโปรเจกต์ใหม่)

โปรเจกต์นี้ถูกดีไซน์มาเพื่อเป็น **Master Template** สำหรับเริ่มต้นโปรเจกต์อื่นๆ ในระบบนิเวศ FutureSign ได้อย่างรวดเร็ว โดยขั้นตอนในการโคลนและตั้งค่าโปรเจกต์ใหม่ มีดังนี้:

### 1. โคลนและล้างประวัติ Git เดิม (Git Clean Start)
โคลนโปรเจกต์นี้ไปยังโฟลเดอร์ใหม่ และทำการเคลียร์ประวัติ Git เพื่อเริ่มสร้าง Repository ใหม่ของโปรเจกต์คุณเอง:
```bash
# 1. โคลนโปรเจกต์ไปยังโฟลเดอร์โปรเจกต์ใหม่ของคุณ
git clone <this-template-repo-url> new-project-name
cd new-project-name

# 2. ล้างโฟลเดอร์ .git เดิมออก (สำหรับ Windows)
Remove-Item -Recurse -Force .git
# หรือสำหรับ macOS/Linux
# rm -rf .git

# 3. เริ่มต้นนับประวัติ Git ใหม่ของโปรเจกต์คุณเอง
git init
git add .
git commit -m "Initial commit from FutureSign Master Template"
```

### 2. ตั้งค่าไฟล์ Environment ของคุณเอง
เนื่องจากความลับและ API Key ต่างๆ จะถูกละเว้นไม่บันทึกขึ้น Git ให้ผู้พัฒนาทำการตั้งค่าไฟล์สำหรับโปรเจกต์ใหม่ดังนี้:
1. ก๊อปปี้ไฟล์ตัวอย่างหลังบ้านและหน้าบ้าน:
   * หลังบ้าน: `cp backend/.env.example backend/.env`
   * หน้าบ้าน: `cp frontend/.env.local.example frontend/.env.local`
2. สร้าง JWT `SECRET_KEY` ใหม่สำหรับหลังบ้านใน `backend/.env` โดยรันคำสั่ง:
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```
3. กำหนดข้อมูลการเชื่อมต่อฐานข้อมูล (`DATABASE_URL`), `CORE_API_KEY` (SSO Key) และโดเมนสำหรับโปรเจกต์ตัวเอง

### 3. เปลี่ยนชื่อแอปและแบรนดิ้ง (App Rename & Branding)
* **หน้าบ้าน (Client-side):** กำหนดชื่อแอปใหม่ในไฟล์ `frontend/.env.local` ผ่านคีย์ `NEXT_PUBLIC_APP_NAME`
* **ระบบโดยรวม (Database):** สามารถปรับชื่อแอป โลโก้ และข้อความหน้าบ้าน รวมถึงสิทธิ์เมนูหลัก ได้จากหน้าจอ Admin Settings Dashboard (เมื่อล็อกอินใช้งานเป็น Admin สำเร็จแล้ว)

---

## 🚀 Quick Start

### Prerequisites
- Docker 24+ (แนะนำ)
- หรือ Python 3.12+ และ Node.js 20 LTS (สำหรับ local dev)

### Option A: Docker (Production / Staging)

```bash
# 1. Clone repository
git clone <your-repo-url>
cd corp-temp

# 2. ตั้งค่า root .env สำหรับ docker-compose (จำเป็น)
#    POSTGRES_PASSWORD ไม่มีค่า default — ต้องกำหนดเอง ไม่เช่นนั้น `docker compose up` จะ error ทันที
#    (ดูตัวอย่างไฟล์ root .env ที่ docs/DEPLOY_GUIDE.md §7.3)

# 3. ตั้งค่า Backend environment
cp backend/.env.example backend/.env
# แก้ไข backend/.env: DATABASE_URL, CORE_API_KEY, SECRET_KEY, CORS_ORIGINS

# 4. ตั้งค่า Frontend environment (optional)
cp frontend/.env.local.example frontend/.env.local
# แก้ไข NEXT_PUBLIC_API_URL ถ้าต้องการ override

# 5. Build และ Start
docker compose up -d --build

# 6. ตรวจสอบ
docker compose ps
docker compose logs -f
```

เปิดใช้งาน:
- Frontend: http://localhost:3012
- Backend API: http://localhost:8012
- API Docs: http://localhost:8012/docs

### Option B: Local Development

```bash
# Terminal 1 — Backend
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # Linux/macOS
pip install -r requirements.txt
cp .env.example .env            # แก้ไขค่าใน .env
uvicorn app.main:app --host 0.0.0.0 --port 8012 --reload

# Terminal 2 — Frontend
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

---

## ⚙️ Configuration

### สิ่งที่ต้องกำหนดก่อนใช้งาน

**1. สร้าง JWT Secret Key ใหม่ (สำคัญมาก)**
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
นำค่าที่ได้ไปใส่ใน `SECRET_KEY` ของ `backend/.env`

**2. กำหนด CORS Origins**
```bash
# backend/.env
CORS_ORIGINS="http://localhost:3012,https://your-production-domain.com"
```

**3. กำหนด Production Cookie Settings**
```bash
# backend/.env
COOKIE_SECURE=True        # บังคับใช้ HTTPS เท่านั้น
COOKIE_SAMESITE="lax"
```

ดูรายละเอียด environment variables ทั้งหมดได้ที่ [`docs/DEPLOY_GUIDE.md`](docs/DEPLOY_GUIDE.md)

---

## 🔑 Default Access

หลัง deploy ครั้งแรก:
1. Login ด้วย Employee ID จาก FutureSign Core-API
2. ผู้ใช้คนแรกที่ login จะได้รับ **Admin role** โดยอัตโนมัติ
3. เข้า Admin Dashboard → Settings → ตั้งค่า App Name, Theme, LINE credentials

---

## 🐳 Docker — เปลี่ยน Port

แก้ไข `docker-compose.yml` ส่วน `ports`:

```yaml
services:
  backend:
    ports:
      - "9011:8011"   # รับที่ port 9011 ภายนอก → 8011 ใน container
  frontend:
    ports:
      - "80:3011"     # รับที่ port 80 (HTTP) → 3011 ใน container
```

> ดูรายละเอียดการเปลี่ยน Port ทุกกรณีได้ที่ [`docs/DEPLOY_GUIDE.md`](docs/DEPLOY_GUIDE.md#7-การเปลี่ยน-port-ใน-docker)

---

## 📦 ต่อยอด Business Logic

Template นี้วาง **Infrastructure** ไว้พร้อม — สิ่งที่ต้องพัฒนาเพิ่มตาม business:

### Backend — เพิ่ม Feature ใหม่
```python
# 1. สร้าง Model ใหม่ใน backend/app/models.py หรือไฟล์แยก
class LeaveRequest(Base):
    __tablename__ = "leave_requests"
    # ... fields

# 2. สร้าง Router ใหม่ใน backend/app/leave_router.py
router = APIRouter(prefix="/leaves", tags=["leaves"])

# 3. Register ใน backend/app/main.py
from app.leave_router import router as leave_router
app.include_router(leave_router, prefix="/api/v1")
```

### Frontend — เพิ่ม Page ใหม่
```
frontend/src/app/dashboard/leave/page.tsx
```

### LINE — เพิ่ม Business Notification
```python
# ใน router ที่ต้องการ — ดึง LINE binding แล้วส่ง Push
binding = await get_employee_line_binding(employee_id, db)
if binding:
    await send_line_push(binding.line_user_id, "✅ คำขอได้รับการอนุมัติแล้ว")
```

ดูรายละเอียดทั้งหมดที่ [`docs/DEPLOY_GUIDE.md → Section 9`](docs/DEPLOY_GUIDE.md)

---

## 🔒 Security — ไม่ควรขึ้น Git

| ไฟล์ | เหตุผล |
|------|--------|
| `backend/.env` | DB credentials, JWT Secret, API Keys |
| `frontend/.env.local` | Environment-specific URLs |
| `**/__pycache__/` | Python compiled files |
| `**/.venv/` | Python virtual environment |
| `**/node_modules/` | Node dependencies |

> ✅ ไฟล์เหล่านี้ถูก `.gitignore` ครอบคลุมแล้ว  
> ⚠️ ตรวจสอบอีกครั้งด้วย `git status` ก่อน `git push` เสมอ

---

## 📖 Documentation

| เอกสาร | คำอธิบาย |
|--------|---------|
| [DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md) | คู่มือ Deploy ฉบับสมบูรณ์ + Business Logic Guide |
| [LINE_SETUP_GUIDE.md](docs/LINE_SETUP_GUIDE.md) | ตั้งค่า LINE OA + LIFF + Webhook |
| [CORE-API_INTEGRATION_GUIDE.md](docs/CORE-API_INTEGRATION_GUIDE.md) | Integration กับ FutureSign Core-API |
| [Backend API Docs](http://localhost:8012/docs) | Swagger UI (เมื่อรัน backend) |

---

## 🗃️ Database Schema

### Tables หลัก

| Table | คำอธิบาย |
|-------|---------|
| `app_settings` | การตั้งค่าระบบ (App Name, Theme, LINE credentials) |
| `local_roles` | Role definitions (Admin, Supervisor, User, ...) |
| `local_users` | ข้อมูลพนักงานที่ sync จาก Core-API |
| `local_menus` | Menu items และ hierarchy |
| `role_menu_permissions` | Permission mapping: Role ↔ Menu |
| `line_bindings` | การ bind LINE User ID ↔ Employee ID |
| `audit_logs` | Activity log ทุก action สำคัญ |

> **Note:** ระบบสร้างตารางอัตโนมัติเมื่อ Backend start ครั้งแรก (ผ่าน `Base.metadata.create_all`)  
> ไม่จำเป็นต้อง run migration แยก

---

## 📋 API Endpoints

| Prefix | คำอธิบาย | Auth |
|--------|---------|------|
| `POST /api/v1/auth/login` | Login | ❌ |
| `POST /api/v1/auth/logout` | Logout | ✅ |
| `GET /api/v1/auth/me` | Current user info | ✅ |
| `GET /api/v1/users` | List users | ✅ Admin |
| `GET /api/v1/roles` | List roles | ✅ |
| `GET /api/v1/menus` | User's accessible menus | ✅ |
| `GET /api/v1/settings` | Public app settings | ❌ |
| `GET /api/v1/settings/admin` | Admin settings (incl. secrets) | ✅ Admin |
| `PATCH /api/v1/settings/admin` | Update settings | ✅ Admin |
| `POST /api/v1/line/register` | LIFF binding request | ❌ |
| `GET /api/v1/line/bindings` | List pending bindings | ✅ Admin |
| `POST /api/v1/line/webhook` | LINE Webhook | ❌ |
| `GET /api/v1/logs` | Activity logs | ✅ Admin |
| `GET /health` | Health check | ❌ |

---

*FutureSign Corporate Template — Built for scalability and rapid deployment*
