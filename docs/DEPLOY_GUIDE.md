# 🚀 Deployment Guide — FutureSign Corporate Web Template

> เอกสารนี้ครอบคลุมการ Deploy ระบบในทุก environment รวมถึงแนวทางการต่อยอด Business Logic
> สำหรับทีมที่นำ Template นี้ไป clone และพัฒนาต่อ

---

## สารบัญ

1. [System Architecture](#1-system-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Environment Variables — สิ่งที่ต้องกำหนดก่อน Deploy](#3-environment-variables)
4. [สิ่งที่ไม่ควรขึ้น Git (Security Checklist)](#4-security-checklist--ไม่ควรขึ้น-git)
5. [Local Development Setup](#5-local-development-setup)
6. [Docker Deployment](#6-docker-deployment)
7. [การเปลี่ยน Port ใน Docker](#7-การเปลี่ยน-port-ใน-docker)
8. [Production Checklist](#8-production-checklist)
9. [Business Logic — สิ่งที่แต่ละ Webapp ต้องทำเอง](#9-business-logic--สิ่งที่แต่ละ-webapp-ต้องทำเอง)
10. [LINE OA Integration](#10-line-oa-integration)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / LINE App                   │
└───────────────────┬─────────────────────────────────────┘
                    │ HTTPS
         ┌──────────▼──────────┐
         │   Next.js Frontend  │  Port 3011
         │   (Standalone SSR)  │
         └──────────┬──────────┘
                    │ Internal API proxy /api/*
         ┌──────────▼──────────┐
         │  FastAPI Backend    │  Port 8011
         │  (Python / uvicorn) │
         └──────┬──────┬───────┘
                │      │
     ┌──────────▼┐  ┌──▼──────────┐
     │ PostgreSQL │  │    Redis    │
     │  Port 5432 │  │  Port 6379  │
     └────────────┘  └─────────────┘
```

**Internal Communication (Docker):**
- Frontend → Backend ผ่าน `/api/*` rewrite → `http://backend:8011`
- Backend → PostgreSQL ผ่าน `db:5432` (docker network)
- Backend → Redis ผ่าน `redis:6379` (docker network)

---

## 2. Prerequisites

| Tool | Version | หมายเหตุ |
|------|---------|---------|
| Docker | 24.x+ | รวม Docker Compose v2 |
| Python | 3.12+ | เฉพาะ Local Dev |
| Node.js | 20 LTS | เฉพาะ Local Dev |
| PostgreSQL | 15+ | หรือใช้ Docker |
| Redis | 7+ | หรือใช้ Docker |

---

## 3. Environment Variables

### 3.1 Backend — `backend/.env`

คัดลอกจาก template แล้วแก้ไขค่า:
```bash
cp backend/.env.example backend/.env
```

| Variable | จำเป็น | คำอธิบาย |
|----------|--------|---------|
| `DATABASE_URL` | ✅ | Connection string PostgreSQL |
| `REDIS_URL` | ✅ | Connection string Redis |
| `CORE_API_URL` | ✅ | URL ของ FutureSign Core-API |
| `CORE_API_KEY` | ✅ | API Key จาก Core-API |
| `SECRET_KEY` | ✅ | JWT signing key — **ต้อง generate ใหม่ทุก webapp** |
| `CORS_ORIGINS` | ✅ | URL ของ Frontend คั่นด้วย `,` |
| `COOKIE_SECURE` | ✅ | `False` = dev (HTTP), `True` = prod (HTTPS) |
| `COOKIE_SAMESITE` | ✅ | `lax` = dev, `none` = cross-site prod |
| `LINE_CHANNEL_ACCESS_TOKEN` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |
| `LINE_CHANNEL_SECRET` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |
| `LINE_LIFF_ID` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |

**สร้าง SECRET_KEY ใหม่:**
```bash
# Linux/macOS/WSL
openssl rand -base64 32

# Python
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

### 3.2 Frontend — `frontend/.env.local`

คัดลอกจาก template แล้วแก้ไขค่า:
```bash
cp frontend/.env.local.example frontend/.env.local
```

| Variable | จำเป็น | คำอธิบาย |
|----------|--------|---------|
| `NEXT_PUBLIC_API_URL` | ✅ | URL ของ Backend (มองเห็นได้จาก browser) |
| `NEXT_PUBLIC_APP_NAME` | ⬜ | ชื่อ App ที่แสดงบน browser tab |
| `NEXT_PUBLIC_LIFF_API_URL` | ⬜ | URL ภายนอกสำหรับ LIFF (เช่น ngrok) เฉพาะ dev |

---

## 4. Security Checklist — ไม่ควรขึ้น Git

> [!CAUTION]
> ไฟล์เหล่านี้ถูก `.gitignore` ครอบคลุมแล้ว แต่ **ต้องตรวจสอบอีกครั้งก่อน `git add`** เสมอ

### ❌ ไฟล์ที่ต้องไม่อยู่บน Git

| ไฟล์ | เหตุผล |
|------|--------|
| `backend/.env` | Database URL, API Keys, JWT Secret Key |
| `frontend/.env.local` | API URLs ที่ specific กับ environment |
| `**/.env.*.local` | Environment-specific secrets ทุกชนิด |
| `*.pem`, `*.key`, `*.crt` | SSL Certificates และ Private Keys |
| `**/__pycache__/` | Python compiled cache |
| `**/.venv/` | Virtual environment |
| `**/node_modules/` | Node.js dependencies |
| `**/.next/` | Next.js build output |
| `backend/node_modules/` | Dev leftover จาก backend |

### ✅ ไฟล์ที่ควรขึ้น Git (ปลอดภัย)

| ไฟล์ | เหตุผล |
|------|--------|
| `backend/.env.example` | Template — ไม่มีค่าจริง |
| `frontend/.env.local.example` | Template — ไม่มีค่าจริง |
| `docker-compose.yml` | ใช้ ENV vars, ไม่มี secrets |
| `backend/Dockerfile` | ไม่มี credentials |
| `frontend/Dockerfile` | ไม่มี credentials |
| `.gitignore` | กำหนด exclusion rules |

### 🔍 ตรวจสอบก่อน Push เสมอ

```bash
# ตรวจว่าไม่มีไฟล์ .env ติดไปใน staging
git status

# ดูรายการไฟล์ที่ถูก ignore แล้ว
git ls-files --ignored --exclude-standard

# ค้นหา secrets ที่อาจหลุดไป (หลังจาก git init)
git diff --cached --name-only | xargs grep -l "password\|secret\|token\|key" 2>/dev/null
```

---

## 5. Local Development Setup

### Backend
```bash
cd backend

# สร้าง virtual environment
python -m venv .venv

# Activate (Windows)
.venv\Scripts\activate
# Activate (Linux/macOS)
source .venv/bin/activate

# ติดตั้ง dependencies
pip install -r requirements.txt

# สร้าง .env จาก example แล้วแก้ไขค่า
cp .env.example .env

# รัน development server
uvicorn app.main:app --host 0.0.0.0 --port 8011 --reload
```

### Frontend
```bash
cd frontend

# ติดตั้ง dependencies
npm install

# สร้าง .env.local จาก example แล้วแก้ไขค่า
cp .env.local.example .env.local

# รัน development server
npm run dev
# → http://localhost:3011
```

### ตรวจสอบ Health
- Frontend: http://localhost:3011
- Backend API: http://localhost:8011/health
- API Docs: http://localhost:8011/docs

---

## 6. Docker Deployment

### 6.1 เตรียม Environment Files

```bash
# Backend
cp backend/.env.example backend/.env
# แก้ไขค่า DATABASE_URL, CORE_API_KEY, SECRET_KEY, CORS_ORIGINS

# Frontend (ถ้าต้องการ override)
cp frontend/.env.local.example frontend/.env.local
# แก้ไข NEXT_PUBLIC_API_URL ให้ชี้ไป public URL ของ backend
```

### 6.2 Build และ Start ทั้งระบบ

```bash
# Build images และ start ทุก service
docker compose up -d --build

# ตรวจสอบ status
docker compose ps

# ดู logs แบบ realtime
docker compose logs -f

# ดู logs เฉพาะ service
docker compose logs -f backend
docker compose logs -f frontend
```

### 6.3 ใช้ PostgreSQL ภายนอก (ไม่ใช้ Docker DB)

หากมี PostgreSQL อยู่แล้วในเซิร์ฟเวอร์หรือใช้ Managed DB:

1. แก้ `backend/.env`:
   ```
   DATABASE_URL=postgresql+asyncpg://USER:PASS@YOUR_DB_HOST:5432/YOUR_DB
   ```
2. แก้ `docker-compose.yml` — ลบ `db` service และ `depends_on.db` ออก
3. Build ใหม่:
   ```bash
   docker compose up -d --build backend frontend redis
   ```

### 6.4 Stop และ Cleanup

```bash
# Stop services (เก็บ volumes/data ไว้)
docker compose stop

# Stop และลบ containers (เก็บ volumes ไว้)
docker compose down

# Stop + ลบ containers + ลบ volumes (ล้างข้อมูลทั้งหมด)
docker compose down -v
```

---

## 7. การเปลี่ยน Port ใน Docker

> [!IMPORTANT]
> Port format ใน Docker คือ `"HOST_PORT:CONTAINER_PORT"`
> - **HOST_PORT** = port บน server ที่ภายนอกเข้าถึงได้
> - **CONTAINER_PORT** = port ภายใน container (ต้องตรงกับ Dockerfile `EXPOSE` และ CMD)

### 7.1 เปลี่ยนเฉพาะ Host Port (แนะนำ)

วิธีนี้ง่ายที่สุด — แก้เฉพาะตัวเลขซ้ายใน `docker-compose.yml`:

```yaml
services:
  backend:
    ports:
      - "9011:8000"   # เปลี่ยน backend ให้เข้าถึงจากภายนอกที่ port 9011 (ภายใน container ยังเป็น 8000)
  frontend:
    ports:
      - "80:3000"     # เปลี่ยน frontend ให้เข้าถึงที่ port 80 (HTTP standard)
  db:
    ports:
      - "5433:5432"   # เปลี่ยน DB port ภายนอกเป็น 5433 (เพื่อไม่ชนกับ DB อื่น)
```

### 7.2 เปลี่ยน Port ทั้งหมด (Container + Host)

ถ้าต้องการรัน backend บน port อื่นใน container ด้วย ต้องแก้ 3 ที่:

**ตัวอย่าง: เปลี่ยน Backend จาก 8000 → 8080**

**1. `backend/Dockerfile`:**
```dockerfile
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

**2. `frontend/next.config.ts`:**
```ts
// ค่า default fallback ถ้าไม่ได้ set ENV
destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"}/api/:path*`
```

**3. `docker-compose.yml`:**
```yaml
backend:
  ports:
    - "8080:8080"
frontend:
  build:
    args:
      NEXT_PUBLIC_API_URL: http://localhost:8080  # URL ที่ browser เห็น
```

### 7.3 ใช้ `.env` ควบคุม Port (Production Best Practice)

สร้างไฟล์ `.env` ที่ root ของโปรเจกต์ (ข้างๆ `docker-compose.yml`):

```bash
# .env (root — สำหรับ docker-compose เท่านั้น)
BACKEND_PORT=8011
FRONTEND_PORT=3011
POSTGRES_PORT=5432
REDIS_PORT=6379
NEXT_PUBLIC_API_URL=https://api.your-domain.com
POSTGRES_USER=corptemp_user
POSTGRES_PASSWORD=your_strong_password
POSTGRES_DB=corptemp_db
```

แล้วใช้ใน `docker-compose.yml`:
```yaml
services:
  backend:
    ports:
      - "${BACKEND_PORT:-8011}:8000"
  frontend:
    ports:
      - "${FRONTEND_PORT:-3011}:3000"
    build:
      args:
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-http://localhost:8011}
```

จากนั้น build:
```bash
docker compose --env-file .env up -d --build
```

> [!NOTE]
> ไฟล์ `.env` ที่ root นี้แตกต่างจาก `backend/.env` — ไม่ควรใส่ DB credentials ซ้ำซ้อนกัน ใช้สำหรับ port/URL configuration เท่านั้น

---

## 8. Production Checklist

### ✅ Security
- [ ] `SECRET_KEY` ถูก generate ใหม่ (ไม่ใช้ค่าจาก example)
- [ ] `COOKIE_SECURE=True` เมื่อใช้ HTTPS
- [ ] `COOKIE_SAMESITE="lax"` หรือ `"none"` ตาม deployment
- [ ] `CORS_ORIGINS` ระบุเฉพาะ domain จริงเท่านั้น (ไม่มี `*`)
- [ ] ไม่มีไฟล์ `.env` ที่มี credentials จริงอยู่บน Git

### ✅ Backend
- [ ] ไม่มี `--reload` flag ใน CMD (Dockerfile production ถูกต้องแล้ว)
- [ ] Database migration ถูกต้อง (ระบบ auto-migrate ที่ startup แล้ว)
- [ ] Redis เชื่อมต่อได้

### ✅ Frontend
- [ ] `NEXT_PUBLIC_API_URL` ชี้ไปที่ production backend URL
- [ ] Build สำเร็จ (`npm run build` ไม่มี error)
- [ ] `output: "standalone"` อยู่ใน `next.config.ts` แล้ว

### ✅ Database
- [ ] ตั้งค่า Admin account ครั้งแรกหลัง deploy
- [ ] ตั้งค่า LINE credentials ผ่าน Admin UI (ถ้าใช้ LINE feature)

---

## 9. Business Logic — สิ่งที่แต่ละ Webapp ต้องทำเอง

Template นี้วาง **Infrastructure** ไว้พร้อมแล้ว แต่ **Business Logic** ที่ specific กับแต่ละองค์กรต้องพัฒนาเพิ่มเอง:

### 9.1 Authentication & Authorization

Template ให้มา:
- Login ผ่าน FutureSign Core-API (SSO กลาง)
- Role-based access (Admin / Supervisor / User)
- Menu permission ตาม Role

**ต้องทำเพิ่มเอง:**
```
[ ] กำหนด Role เพิ่มตาม business เช่น HR, Finance, Manager
[ ] ตั้งค่า Menu permission แต่ละ Role ผ่าน Admin UI
[ ] เพิ่ม permission check ในระดับ data เช่น "ดู record ได้เฉพาะของ department ตัวเอง"
```

### 9.2 Core Business Features

Template ให้มา:
- โครงสร้างฐานข้อมูลพื้นฐาน
- CRUD pattern ตัวอย่าง (Users, Roles, Menus, Settings)
- Audit Log ระบบ (บันทึกทุก action สำคัญ)

**ต้องทำเพิ่มเอง:**
```
[ ] สร้าง Models ใหม่ตาม business domain เช่น Leave, Document, Inventory
[ ] สร้าง API Routers ใหม่ใน backend/app/
[ ] สร้าง Frontend Pages ใหม่ใน frontend/src/app/dashboard/
[ ] Register router ใหม่ใน main.py
[ ] เพิ่ม seed data ที่จำเป็น (เช่น ประเภทเอกสาร, หมวดหมู่)
```

**ตัวอย่าง เพิ่ม Feature ใหม่ (Leave Request):**
```python
# backend/app/leave_model.py
class LeaveRequest(Base):
    __tablename__ = "leave_requests"
    id: Mapped[uuid.UUID] = ...
    employee_id: Mapped[str] = ...
    leave_type: Mapped[str] = ...  # annual, sick, personal
    start_date: Mapped[date] = ...
    end_date: Mapped[date] = ...
    status: Mapped[str] = ...  # PENDING, APPROVED, REJECTED
    approved_by: Mapped[str | None] = ...

# backend/app/leave_router.py — สร้าง CRUD endpoints

# backend/app/main.py — เพิ่ม:
from app.leave_router import router as leave_router
app.include_router(leave_router, prefix="/api/v1")
```

### 9.3 Notification System

Template ให้มา:
- LINE Binding infrastructure พร้อมใช้
- ตัวอย่าง Push Notification helper

**ต้องทำเพิ่มเอง:**
```
[ ] กำหนด Event ที่จะ trigger notification เช่น "เมื่ออนุมัติ Leave"
[ ] ออกแบบ LINE Message template (Flex Message) ตาม business
[ ] เชื่อม notification กับ workflow เช่น approve → ส่ง LINE แจ้งผู้ขอ
[ ] ตั้งค่า Webhook URL ใน LINE Developer Console
```

**ตัวอย่าง:**
```python
# ในไฟล์ leave_router.py เมื่ออนุมัติ leave
async def approve_leave(leave_id: str, db: AsyncSession, admin_id: str):
    leave = ...  # fetch leave request
    leave.status = "APPROVED"
    
    # ดึง LINE binding ของพนักงาน
    binding = await get_employee_binding(leave.employee_id, db)
    if binding:
        await send_line_push(
            line_user_id=binding.line_user_id,
            message=f"✅ คำขอลาของคุณได้รับการอนุมัติแล้ว ({leave.start_date} - {leave.end_date})"
        )
```

### 9.4 Reporting & Dashboard

Template ให้มา:
- Activity Logs พร้อม filter
- User Management dashboard

**ต้องทำเพิ่มเอง:**
```
[ ] สร้าง Dashboard widgets ตาม KPI ของ business
[ ] สร้าง Report export (CSV/PDF)
[ ] สร้าง Charts สำหรับ data visualization
[ ] Scheduled reports (ถ้าต้องการ)
```

### 9.5 Frontend Pages Pattern

ทุก Feature page ใหม่ควรวางที่:
```
frontend/src/app/dashboard/[feature-name]/page.tsx
```

Pattern มาตรฐานที่ใช้ในโปรเจกต์:
```tsx
"use client"
import { useEffect, useState } from "react"

export default function FeaturePage() {
  const [data, setData] = useState([])
  
  useEffect(() => {
    fetch("/api/v1/your-feature", { credentials: "include" })
      .then(r => r.json())
      .then(setData)
  }, [])
  
  return (
    <div className="space-y-6">
      <h1>Feature Name</h1>
      {/* UI Components */}
    </div>
  )
}
```

---

## 10. LINE OA Integration

### สิ่งที่ Template จัดให้แล้ว (ไม่ต้องทำ)
- ✅ ระบบ Binding (LINE User ID ↔ Employee ID)
- ✅ Admin Dashboard สำหรับ Approve/Reject/Revoke Binding
- ✅ LIFF Register Page สำหรับพนักงาน
- ✅ ตั้งค่า LINE Credentials ผ่าน Admin UI
- ✅ Webhook endpoint โครงสร้างพร้อม

### สิ่งที่ต้องทำในแต่ละ Webapp
1. **สร้าง LINE OA** ใน LINE Developer Console
2. **ตั้งค่า LIFF App** ชี้ไปที่ `/liff/register` ของโปรเจกต์
3. **ตั้งค่า Webhook URL** ชี้ไปที่ `/api/v1/line/webhook`
4. **ใส่ Credentials** ใน Admin Dashboard → Settings → LINE OA
5. **เพิ่ม Business Logic** ใน `line_router.py` เช่น push message events

### ข้อมูลเพิ่มเติม
ดูรายละเอียดได้ที่ [`docs/LINE_SETUP_GUIDE.md`](LINE_SETUP_GUIDE.md)

---

*Last updated: 2026-06-04 | FutureSign Corporate Template v1.x*
