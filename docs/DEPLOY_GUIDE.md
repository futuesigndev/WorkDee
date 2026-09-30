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
11. [Photo Storage — ที่เก็บรูปเช็คอิน (งาน 020)](#11-photo-storage--ที่เก็บรูปเช็คอิน-งาน-020)
12. [รายการลงเวลา และการตรวจสอบยอมรับ/ไม่ยอมรับ (งาน 022)](#12-รายการลงเวลา-และการตรวจสอบยอมรับไม่ยอมรับ-งาน-022)
13. [Session และการตัดสิทธิ์ทันที (งาน 023)](#13-session-และการตัดสิทธิ์ทันที-งาน-023)
14. [Runtime facts — สิ่งที่ต้องรู้ก่อน deploy (งาน 033)](#14-runtime-facts--สิ่งที่ต้องรู้ก่อน-deploy-งาน-033)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / LINE App                   │
└───────────────────┬─────────────────────────────────────┘
                    │ HTTPS
         ┌──────────▼──────────┐
         │   Next.js Frontend  │  Port 3019
         │   (Standalone SSR)  │
         └──────────┬──────────┘
                    │ Internal API proxy /api/*
         ┌──────────▼──────────┐
         │  FastAPI Backend    │  Port 8019
         │  (Python / uvicorn) │
         └──────┬──────┬───────┘
                │      │
     ┌──────────▼┐  ┌──▼──────────┐
     │ PostgreSQL │  │    Redis    │
     │  Port 5432 │  │  Port 6379  │
     └────────────┘  └─────────────┘
```

**Internal Communication (Docker):**
- Frontend → Backend ผ่าน `/api/*` rewrite ของ Next server (ไม่ได้เรียกจากเบราว์เซอร์) — **ปลายทางคือค่า
  `NEXT_PUBLIC_API_URL` ที่ฝังตอน build** ไม่ใช่ชื่อ service ใน compose: ตั้งใน `frontend/.env.local`
  หรือ build arg `NEXT_PUBLIC_API_URL` ของ compose (ดู §3.2, §6.1) ค่า default ใน
  `docker-compose.yml` (`http://localhost:8019`) เหมาะกับ dev บนเครื่องเดียวเท่านั้น — ใน container
  ต้องเป็น URL ที่ container ของ frontend เรียกถึงได้จริง ไม่งั้นหน้าเว็บจะได้ 500 จาก rewrite
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
| `APP_NAME` | ⬜ | ชื่อแอปที่ FastAPI ใช้ (`title` ของ API และคำตอบ `/health`) — default `WorkDee`; **ชื่อที่ผู้ใช้เห็นบนหน้าเว็บมาจาก `app_settings.app_name`** (แก้ที่ Admin UI → Settings) ไม่ใช่ค่านี้ |
| `ALGORITHM` | ⬜ | อัลกอริทึมที่ใช้ถอด/ตรวจ JWT — default `HS256` (WorkDee ไม่มีกุญแจของ Core-API จึงใช้ค่านี้กับ token ที่ตัวเองออกเท่านั้น) |
| `CORS_ORIGINS` | ✅ | URL ของ Frontend คั่นด้วย `,` (ค่า default ในโค้ด: `http://localhost:3019,http://127.0.0.1:3019`) |
| `COOKIE_SECURE` | ✅ | `False` = dev (HTTP), `True` = prod (HTTPS) |
| `COOKIE_SAMESITE` | ✅ | `lax` = dev, `none` = cross-site prod |
| `REFRESH_TOKEN_EXPIRE_SECONDS` | ⬜ | อายุ cookie ของ refresh token — default `604800` (7 วัน) |
| `ACCESS_TOKEN_EXPIRE_SECONDS` | ⬜ | default `900` — **โค้ดส่วนไหนก็ไม่อ่านค่านี้แล้ว** (ดู §13): WorkDee ไม่ได้เป็นคนกำหนดอายุ access token (Core-API เป็นคนออกและกำหนด) ค่านี้จึงเป็นเพียงตัวเลขอ้างอิงที่ตกค้างอยู่ |
| `SESSION_MAX_RENEWALS` | ⬜ | จำนวนครั้งสูงสุดที่ session หนึ่งต่ออายุอัตโนมัติได้ — default `3` (ดู §13) |
| `SESSION_MAX_AGE_MINUTES` | ⬜ | เวลารวมสูงสุดของการ login 1 ครั้ง (นาที) — default `60` (ดู §13) |
| `APP_ENV` | ⬜ | ชื่อ environment — `development` (default) หรือ `production` เมื่อ deploy (ปัจจุบันเป็นข้อมูลประกอบเท่านั้น ไม่มีโค้ดส่วนไหนอ้างอิง) |
| `LINE_CHANNEL_ACCESS_TOKEN` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |
| `LINE_CHANNEL_SECRET` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |
| `LINE_LIFF_ID` | ⬜ | Optional — ตั้งผ่าน Admin UI แทนได้ |
| `LINE_API_BASE` | ⬜ | host ของ LINE Messaging API — default `https://api.line.me` (มีไว้ให้ test/stub ชี้ไปที่อื่น ปลายทางใน production ไม่ต้องแก้) |
| `LINE_DATA_API_BASE` | ⬜ | host ของ LINE data API ที่ใช้อัปโหลดรูป rich menu — default `https://api-data.line.me` (เหตุผลเดียวกับ `LINE_API_BASE`) |
| `ENABLE_API_DOCS` | ⬜ | เปิด `/docs`, `/redoc`, `/openapi.json` — **default `false`** (ปิด) ควรเปิดเฉพาะตอนพัฒนา |
| `SQL_ECHO` | ⬜ | พิมพ์ทุกคำสั่ง SQL ลง log — **default `false`** (ปิด) |
| `PHOTO_STORAGE_DIR` | ⬜ | โฟลเดอร์เก็บรูปเช็คอิน — default `storage/checkin_photos` (อยู่ในโฟลเดอร์ backend) ดูหัวข้อ 11 |
| `PHOTO_MAX_BYTES` | ⬜ | ขนาดรูปสูงสุด (ไบต์) — default 5 MB (`5242880`) |

> ทั้ง 4 ตัวเป็นค่าฝั่ง infrastructure ไม่มีหน้าเว็บให้แก้ — บน production ค่าที่ไม่ถูกต้องจะถูกปรับเป็นค่า default พร้อม log เตือน 1 บรรทัด (ไม่ทำให้แอปเริ่มไม่ได้)

> [!NOTE]
> **WorkDee ไม่ได้ต่อ Oracle โดยตรงและไม่ต้องตั้งค่า `ORACLE_*` ใด ๆ** — ข้อมูลพนักงานทั้งหมด (รวมแผนก/ฝ่าย)
> มาจาก FutureSign Core-API ผ่าน `CORE_API_URL` + `CORE_API_KEY` เท่านั้น ถ้ามีคีย์ `ORACLE_*` ค้างอยู่ใน
> `backend/.env` (เช่นยกมาจาก template หรือเครื่องอื่น) มันจะถูก **เพิกเฉย** — `config.py` ตั้ง
> `extra="ignore"` ไว้ คีย์ที่ไม่รู้จักจึงไม่ทำให้แอปเริ่มไม่ได้ และไม่มีโค้ดส่วนไหนอ่านคีย์เหล่านั้น

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
| `NEXT_PUBLIC_API_URL` | ✅ | URL ของ Backend (มองเห็นได้จาก browser) — ค่า default ในโค้ดคือ `http://localhost:8019` และเป็นปลายทางของ `/api/*` rewrite ด้วย |
| `NEXT_PUBLIC_APP_NAME` | ⬜ | ชื่อ App ที่แสดงบน browser tab (ค่าเริ่มต้นก่อนที่ชื่อจาก `app_settings.app_name` จะโหลดเสร็จ) |
| `NEXT_PUBLIC_LIFF_API_URL` | ⬜ | URL สาธารณะของ frontend สำหรับทดสอบ LIFF/Webhook ผ่าน tunnel เฉพาะ dev (ใช้สร้าง `allowedDevOrigins` ของ `next dev` — ไม่มีผลกับ production build) |
| `NEXT_PUBLIC_LIFF_ID` | ⬜ | LIFF ID สำรองของหน้า “QR Code” ใน dashboard/line (ค่าจริงอ่านจาก Admin UI → Settings) ใช้เฉพาะเมื่อยังไม่ได้ตั้งค่าใน DB |

> [!IMPORTANT]
> ค่าที่ขึ้นต้นด้วย `NEXT_PUBLIC_` **ถูกฝังตอน build** ไม่ได้อ่านตอนรัน: ใน Docker ต้องส่งเป็น build arg
> (`NEXT_PUBLIC_API_URL` ตั้งไว้แล้วใน `docker-compose.yml` → §6.1) การแก้ `.env.local` บนเครื่องที่รันอยู่
> ไม่มีผลกับ bundle ที่ build ไปแล้ว — ต้อง build ใหม่เสมอ

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
uvicorn app.main:app --host 0.0.0.0 --port 8019 --reload
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
# → http://localhost:3019
```

### ตรวจสอบ Health
- Frontend: http://localhost:3019
- Backend API: http://localhost:8019/health (ตอบ `{"status":"ok","app":"…"}` — ชื่อแอปคือ `APP_NAME`)
- API Docs: http://localhost:8019/docs — **เปิดเฉพาะเมื่อ `ENABLE_API_DOCS=true`** เท่านั้น (default ปิดอยู่
  ทั้ง `/docs`, `/redoc` และ `/openapi.json` จึงตอบ 404 ถ้าไม่ได้เปิด — §3.1, §11)

---

## 6. Docker Deployment

### 6.1 เตรียม Environment Files

> [!IMPORTANT]
> `POSTGRES_PASSWORD` **ไม่มีค่า default แล้ว** — ถ้าไม่กำหนด `docker compose up` จะหยุดทันทีพร้อม error
> `POSTGRES_PASSWORD must be set` เพื่อกันไม่ให้หลุดไปใช้รหัสอ่อน ๆ บน production
> (กำหนดผ่าน root `.env` หรือ environment variable — ตัวอย่างดู §7.3)

```bash
# 1. Root .env — จำเป็นสำหรับ docker-compose interpolation (ต้องมี POSTGRES_PASSWORD)
# 2. Backend
cp backend/.env.example backend/.env
# แก้ไขค่า DATABASE_URL, CORE_API_KEY, SECRET_KEY, CORS_ORIGINS

# 3. Frontend (ถ้าต้องการ override)
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
BACKEND_PORT=8019
FRONTEND_PORT=3019
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
      - "${BACKEND_PORT:-8019}:8000"
  frontend:
    ports:
      - "${FRONTEND_PORT:-3019}:3000"
    build:
      args:
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-http://localhost:8019}
```

จากนั้น build:
```bash
docker compose --env-file .env up -d --build
```

> [!NOTE]
> ไฟล์ `.env` ที่ root นี้แตกต่างจาก `backend/.env` — ใช้สำหรับ `docker-compose.yml` interpolation
> (ports / public URL) **และ `POSTGRES_PASSWORD` ซึ่งจำเป็น** เพราะ compose ไม่มีค่า default ให้แล้ว
> ส่วน `DATABASE_URL` ที่ backend ใช้จริงยังตั้งใน `backend/.env` ตามเดิม

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
- [ ] เข้าใจว่า startup ทำอะไรกับ DB (ดู §14.4): `create_all` + `ALTER TABLE ... IF NOT EXISTS` + `seed_data()`
      ทำ **ทุกครั้งที่ start** (idempotent) และ **Alembic ไม่ได้ถูกใช้กับฐานข้อมูลจริง** (ไม่มี `alembic_version`)
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
2. **ตั้งค่า LIFF App** ชี้ Endpoint URL ไปที่ `/liff` ของโปรเจกต์ (prefix ที่คลุมหน้า LIFF ทุกหน้า: `/liff/checkin`, `/liff/history`, `/liff/register` — อย่าตั้งเป็น `/liff/register` หรือ root ของเว็บ ดู `LINE_SETUP_GUIDE.md` ข้อ 2.5)
3. **ตั้งค่า Webhook URL** ชี้ไปที่ `/api/v1/line/webhook`
4. **ใส่ Credentials** ใน Admin Dashboard → Settings → LINE OA
5. **เพิ่ม Business Logic** ใน `line_router.py` เช่น push message events

### ข้อมูลเพิ่มเติม
ดูรายละเอียดได้ที่ [`docs/LINE_SETUP_GUIDE.md`](LINE_SETUP_GUIDE.md)

---

## 11. Photo Storage — ที่เก็บรูปเช็คอิน (งาน 020)

งาน 020 วาง "ชั้นเก็บรูป" ไว้เท่านั้น (ยังไม่มีหน้าอัปโหลด/เช็คอิน) รูปถูกเก็บเป็นไฟล์ในโฟลเดอร์ที่กำหนดจาก
`PHOTO_STORAGE_DIR` และ **อ่านกลับได้ทางเดียว** คือ API ที่ต้องล็อกอิน (`GET /api/v1/attendance/photos/<key>`)
ซึ่งต้องมีสิทธิ์เมนู `attendance-records` (งาน 022 ย้ายจาก `work-profiles` เพราะรูปคือหลักฐานที่ผูกกับตัวบุคคล)
— ไม่มีการ mount โฟลเดอร์เป็น static ใด ๆ และฝั่งมือถือไม่ได้รับ path ตรง ๆ

| ค่า | ความหมาย |
|---|---|
| `PHOTO_STORAGE_DIR` | โฟลเดอร์เก็บรูป — ค่า default `storage/checkin_photos` ซึ่ง **อ้างอิงจากโฟลเดอร์ `backend/`** ไม่ใช่ current working directory ของ process |
| `PHOTO_MAX_BYTES` | ขนาดสูงสุดต่อรูป (ไบต์) — default 5 MB; ค่าที่ไม่ใช่จำนวนเต็มบวกจะถูกปรับเป็นค่า default พร้อม log เตือน 1 บรรทัด |

**รูปแบบไฟล์ที่เก็บ:** `YYYY/MM/DD/<uuid 32 ตัว hex>.<jpg\|png\|webp>` โดยวันที่เป็นวันที่ไทย (Asia/Bangkok)
ชนิดไฟล์ตัดสินจาก **magic bytes** จริง (JPEG/PNG/WebP เท่านั้น) ไม่เชื่อ content-type ที่ client ส่งมา และไม่มีการ
แปลง/ย่อรูป ชื่อไฟล์ไม่มีรหัสพนักงาน ชื่อพนักงาน หรือข้อความที่ผู้ใช้พิมพ์

**การอ่านรูปกลับ (กันการหลุดออกนอกโฟลเดอร์):** key ที่ขอจะถูก `resolve()` (ตาม symlink) แล้วต้องยังอยู่
ในโฟลเดอร์เก็บรูป — key ที่ชี้ _ออกนอก_ โฟลเดอร์แม้ผ่าน symlink จะถูกปฏิเสธพร้อม log 1 บรรทัด และไม่มีการอ่าน
ไฟล์นั้น ปกติรูปอ่านได้ทางเดียวคือ `GET /api/v1/attendance/photos/{key}` ที่ต้องมีสิทธิ์เมนู `attendance-records`
ไม่มี static mount ของโฟลเดอร์รูป

**เพดานการอัปโหลดเช็คอิน (งาน 021) — สองชั้น:**

| ชั้น | เพดาน | เกิดอะไรขึ้นเมื่อเกิน |
|---|---|---|
| ต่อไฟล์รูป | `PHOTO_MAX_BYTES` (default 5 MB) ตรวจจาก magic bytes จริง | รูปไม่ถูกบันทึก (log WARNING) แต่ **การลงเวลายังสำเร็จ** เป็นรายการที่ “ไม่มีรูป” — รูปเป็นข้อมูลประกอบ ไม่ใช่เงื่อนไขของการลงเวลา |
| ต่อคำขอ | middleware ใน `main.py` เทียบ `content-length` กับ `PHOTO_MAX_BYTES + 262144` (slack ของ multipart) ก่อนอ่าน body | ตอบ **413** พร้อมข้อความไทย (เกิน 10 เท่าของเพดานได้อีกข้อความ) endpoint นี้จึง **ไม่ตอบ 422** เพราะทุกฟิลด์เป็น optional โดยตั้งใจ |

### การ mount NAS บน Ubuntu (สำหรับ production)

1. **mount ก่อน start service** — backend สร้างโฟลเดอร์ให้เองถ้ายังไม่มี แต่จะทำได้ก็ต่อเมื่อ mount พร้อมแล้ว
2. **ต้อง mount แบบที่ systemd ไม่บล็อกการบูต** — ใส่ `nofail` ใน `/etc/fstab` (และ `_netdev` ถ้าเป็น network share)
   แล้วผูกหน่วย mount กับ service ของ backend เช่น
   ```ini
   # /etc/systemd/system/workdee-backend.service.d/override.conf
   [Unit]
   RequiresMountsFor=/mnt/nas/workdee
   After=network-online.target
   ```
   ไม่ใส่ `RequiresMountsFor` แล้วระบบอาจ start backend ตอนที่ NAS ยังไม่พร้อม — แอปจะยังทำงานได้
   (ดูข้อถัดไป) แต่จะบันทึกเช็คอินแบบไม่มีรูป
3. **สิทธิ์การเขียนของ service user** — โฟลเดอร์ปลายทางต้องเขียนได้ โดยปกติคือ `chown -R www-data:www-data`
   (หรือ user ที่รัน service) ตัวอย่าง fstab:
   ```
   //nas.local/photos  /mnt/nas/workdee  cifs  credentials=/etc/workdee-nas.creds,uid=www-data,gid=www-data,_netdev,nofail  0  0
   ```
4. **บน Windows** ห้ามใช้ path แบบ `D:\...` กับ service — ให้เป็น path ของ Linux เท่านั้น

### ถ้า storage ใช้ไม่ได้

- แอป **ยังสตาร์ทได้เสมอ** และ log 1 บรรทัด (WARNING) บอกโฟลเดอร์กับสาเหตุ — งานเช็คอินในอนาคตจะบันทึก
  การลงเวลาไว้แล้วติดธงว่า "ไม่มีรูป" (ไม่มีการลงเวลาที่หายไป)
- mount หายระหว่างวันแล้วกลับมา: คำขอถัดไปที่เขียนสำเร็จจะกลับมาทำงานเองโดยไม่ต้อง restart backend
- ตรวจสุขภาพโฟลเดอร์ได้จากบรรทัด `photo storage ready at ...` (INFO) ตอน startup หรือสั่งเรียกฟังก์ชัน
  `photo_storage.check_configured_storage()` ใน backend

### Runtime flags ที่ควรรู้ (งาน 019)

| Flag | Default | ผล |
|---|---|---|
| `ENABLE_API_DOCS` | `false` | เปิด `/docs`, `/redoc`, `/openapi.json` — **ปิดไว้ใน production** เปิดเฉพาะตอนพัฒนา |
| `SQL_ECHO` | `false` | พิมพ์ทุกคำสั่ง SQL ลง log — เปิดเฉพาะตอน debug (log จะใหญ่และช้า) |

ทั้งสองค่าถือว่า "เปิด" เฉพาะ `1, true, yes, on, t, y` (ไม่สนตัวพิมพ์) ค่าอื่นถือเป็นปิด — พิมพ์ผิดจึงไม่ทำให้
แอปเริ่มไม่ได้

> [!NOTE]
> **Retention/cleanup ยังไม่ได้ทำ** — ยังไม่มีงานลบรูปตามอายุ เพราะระยะเวลาเก็บเป็นข้อตัดสินใจ PDPA ที่ยังไม่สรุป
> (ดู `docs/03-phase0-risk-pdpa.md`) ตอนนี้รูปจะถูกเก็บไว้จนกว่างานนั้นจะเสร็จ
> นอกจากนี้ยังไม่ได้ลบ EXIF/GPS ออกจากรูปในขั้นตอนนี้ — เป็นประเด็นที่ต้องตัดสินใจในงานเช็คอิน

---

## 12. รายการลงเวลา และการตรวจสอบยอมรับ/ไม่ยอมรับ (งาน 022)

งาน 022 เพิ่มหน้าจอฝ่ายบุคคลสำหรับดูรายการลงเวลาและเคลียร์รายการที่มีธง พร้อมเมนูใหม่
**"รายการลงเวลา"** (key `attendance-records` อยู่ใต้กลุ่ม Operation — เป็นงานประจำของ HR ไม่ใช่หน้าตั้งค่า)

| Endpoint | สิทธิ์ | ทำอะไร |
|---|---|---|
| `GET /api/v1/attendance/checkins` | `attendance-records` | รายการ + ตัวกรอง (ช่วงวันที่, รหัส/ชื่อพนักงาน, ธง, สถานะเวลา, สถานะตำแหน่ง, สถานะตรวจ, `has_flags`) + แบ่งหน้า |
| `GET /api/v1/attendance/checkins/summary` | `attendance-records` | ตัวเลขบนชิป (ทั้งหมด/ปกติ/รอตรวจ/ยอมรับแล้ว/ไม่ยอมรับ + แยกตามธง) ค่าเริ่มต้น = วันนี้ (Asia/Bangkok) |
| `GET /api/v1/attendance/checkins/{id}` | `attendance-records` | รายละเอียดหนึ่งรายการ รวมพิกัดและ `photo_url` |
| `PATCH /api/v1/attendance/checkins/{id}/review` | `attendance-records` | ยอมรับ (`ACCEPTED`) หรือไม่ยอมรับ (`REJECTED` — **ต้องระบุเหตุผล**) |
| `POST /api/v1/attendance/checkins/review-bulk` | `attendance-records` | ยอมรับหลายรายการพร้อมกัน (สูงสุด 100) — ไม่ยอมรับเป็นกลุ่มไม่ได้ เพราะต้องมีเหตุผลรายตัว |
| `GET /api/v1/attendance/photos/{key}` | `attendance-records` | รูปหลักฐานของรายการนั้น |

**ความหมาย:** `ACCEPTED` = รายการนี้ถูกต้อง ธงอธิบายได้ · `REJECTED` = ไม่นับรายการนี้ (ต้องระบุเหตุผล)
การตรวจสอบ **ไม่แก้ข้อมูลฝั่งพนักงานและไม่แจ้งเตือนพนักงาน** และเขียน `audit_logs` แบบ `ATTENDANCE_REVIEW`
โดยเก็บแค่ความยาวของเหตุผล ไม่เก็บข้อความเหตุผล ไม่เก็บพิกัด และไม่เก็บชื่อไฟล์รูป

**การย้ายสิทธิ์ (breaking change ที่ตั้งใจ):** เดิมทั้ง `GET /attendance/checkins` และ
`GET /attendance/photos/{key}` ใช้ key `work-profiles` ตอนนี้ใช้ `attendance-records` — ถ้า Role ไหนเคยดูรูปได้
เพราะมี `work-profiles` ต้องไปให้สิทธิ์เมนู `รายการลงเวลา` เพิ่มที่ Admin UI (Roles & Permissions)
Role `Admin` ได้สิทธิ์อัตโนมัติจาก seed ตอน startup

> [!NOTE]
> งาน 022 ยังไม่ทำ export/CSV, กราฟ, การแจ้งเตือนพนักงาน และการลบรูปตามอายุ
> (ดูข้อ 11) — เหล่านี้เป็นงานถัดไป

### ส่งออกไฟล์ CSV (งาน 024)

ปุ่ม **"ส่งออกไฟล์"** (ข้างช่วงวันที่) เปิดหน้าต่างให้เลือก **รายละเอียดรายการ** (หนึ่งแถวต่อการลงเวลาหนึ่งครั้ง)
หรือ **สรุปรายวัน** (หนึ่งแถวต่อพนักงานหนึ่งคนต่อหนึ่งวัน) พร้อมแก้ช่วงวันที่ได้ในหน้าต่างนั้น

- **รายการที่นับ:** ค่าเริ่มต้นนับเฉพาะรายการที่ตัดสินแล้ว — `CLEAN` (ไม่มีอะไรต้องตรวจ) และ `ACCEPTED`
  (ยอมรับแล้ว) ถ้าต้องการรวม `PENDING_REVIEW` (รอตรวจ) ต้องติ๊ก **"รวมรายการที่รอตรวจ"** และ `REJECTED`
  (ไม่ยอมรับ) จะออกในไฟล์เฉพาะเมื่อติ๊ก **"รวมรายการที่ไม่ยอมรับ"** — ทุกแถวมีคอลัมน์ "สถานะตรวจ"
  ภาษาไทยกำกับ จึงไม่มีทางเข้าใจผิดว่ารายการที่ยังไม่ตรวจคือรายการที่อนุมัติแล้ว
- **รูปแบบไฟล์:** UTF-8 **มี BOM** เพื่อให้ Excel แสดงภาษาไทยถูกต้อง · ข้อความที่ขึ้นต้นด้วย `= + - @`
  (หรือ TAB/CR) ถูกเติม `'` นำหน้าเพื่อกันสูตรอันตราย · เครื่องหมายจุลภาค/อัญประกาศ/ขึ้นบรรทัดใหม่ในหมายเหตุ
  ถูก quote ตามมาตรฐาน CSV · เวลาเป็นเขตเวลาไทย `HH:MM:SS` และวันที่เป็น `YYYY-MM-DD`
  ชื่อไฟล์เป็น ASCII เช่น `attendance-detail_2026-09-01_2026-09-30.csv`
- **ข้อมูลส่วนบุคคล:** ไฟล์ **ไม่มีพิกัด ไม่มีชื่อ/ที่อยู่ไฟล์รูป และไม่มี LINE user id** —
  มีเฉพาะสิ่งที่ฝ่ายเงินเดือนต้องใช้ (รหัสพนักงาน ชื่อ แผนก เวลา ผลการตรวจ)
- **เพดานและสิทธิ์:** ครั้งละไม่เกิน 50,000 แถว เกินกว่านั้นได้ 422 พร้อมข้อความไทยให้ลดช่วงวันที่
  ช่วงวันที่ใช้กติกาเดิมของหน้ารายการ (เริ่ม ≤ สิ้นสุด, ไม่เกิน 92 วัน) และใช้สิทธิ์เมนู `attendance-records`
  เดิม — ไม่มีเมนูหรือสิทธิ์ใหม่
- **การตรวจสอบย้อนหลัง:** ทุกครั้งที่ดาวน์โหลด **สำเร็จ** เขียน `audit_logs` 1 แถว `ATTENDANCE_EXPORT`
  (ชนิดไฟล์ ช่วงวันที่ จำนวนแถว และตัวเลือกที่ติ๊ก — ไม่มีรหัสพนักงานและไม่มีเนื้อหาในไฟล์)
  ถ้าการดาวน์โหลดถูกตัดกลางทาง จะไม่มีการเขียน audit เลย

---

## 13. Session และการตัดสิทธิ์ทันที (งาน 023)

**Session ทำงานอย่างไร:** token ทั้งคู่ (access / refresh) ออกโดย Core-API ไม่ใช่ backend นี้ — backend เพียง
เก็บลง cookie แบบ httpOnly (`access_token`, `refresh_token`) โดย **อายุ cookie ของ access = อายุสูงสุดของ session
(`SESSION_MAX_AGE_MINUTES`, ค่าเริ่มต้น 60 นาที)** และ cookie ของ refresh = `REFRESH_TOKEN_EXPIRE_SECONDS` (7 วัน)
ส่วนอายุจริงของตัว token เป็นของ Core-API (วัดได้ 30 นาที — ดูหมายเหตุท้ายหัวข้อ) การยืนยันตัวตนทุกคำขอ =
`GET /api/v1/auth/me` ที่ Core-API (ถ้า Core-API ปิด → 401) และ refresh token ถูกเก็บใน Redis ที่คีย์
`<employee_id>:refresh_token` ซึ่งเป็นด่านยกเลิก session ที่ลบทันที (logout / ลบผู้ใช้ / ปิดใช้งาน / ครบโควตา)

**ต่ออายุอัตโนมัติได้ไม่เกิน 3 ครั้ง แล้วต้อง login ใหม่ (งาน 028):** เมื่อ access token หมดอายุ หน้าเว็บจะเรียก
`POST /auth/refresh` ให้เองโดยไม่รบกวนผู้ใช้ โดยมีเพดานสองชั้นที่บังคับใช้ที่ฝั่ง backend:

| ตัวนับ | ค่าเริ่มต้น | เปลี่ยนที่ |
|---|---|---|
| จำนวนครั้งที่ต่ออายุได้ต่อการ login 1 ครั้ง | 3 (`SESSION_MAX_RENEWALS`) | `backend/.env` หรือค่า default ใน `app/config.py` |
| เวลารวมสูงสุดของการ login 1 ครั้ง | 60 นาที (`SESSION_MAX_AGE_MINUTES`) | เหมือนกัน (แก้ที่เดียว) |

- เก็บตัวนับ (`renewals`, `started_at`) ไว้ใน Redis ที่คีย์ `<employee_id>:session_meta` และรีเซ็ตทุกครั้งที่ login ใหม่
- ครั้งที่ 4 หรือเมื่อเลย 60 นาที → `POST /auth/refresh` ตอบ **401**, ล้าง cookie ทั้งคู่, ลบทุกคีย์ของ session นั้น
  และหน้าเว็บพาไป `/login?expired=1` พร้อมข้อความ "เซสชันหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่อีกครั้ง" (ไม่มีลูป ไม่มีหน้าเปล่า)
- `/auth/*` หาเจ้าของ session จาก **refresh token ของผู้เรียกเอง** (คีย์ `refresh_owner:<sha256>` → employee id)
  ไม่ได้เชื่อ `sub` ใน cookie ของ access token อีกต่อไป เพราะ WorkDee ไม่มีกุญแจเซ็นของ Core-API
  การปลอม cookie จึงได้ 401 และไม่สามารถไปลบ session ของคนอื่นได้ (ดู `028-report.md`)
- **ตัวนับต่อรหัสพนักงาน ไม่ใช่ต่ออุปกรณ์**: เครื่องที่ 2 ของคนเดียวกันจะใช้ตัวนับก้อนเดียวกัน (Redis เก็บ refresh token
  ต่อ employee id ตัวเดียวอยู่แล้ว) และการ login ซ้ำจะแทนที่ session เดิม
- การหมุน refresh token ของ Core-API ไม่ถือเป็นการ login ใหม่ — ตัวนับไม่ถูกรีเซ็ต
- สองแท็บที่ต่ออายุพร้อมกันนับเป็น **1 ครั้ง** (มี marker ต่อ token และมีช่วงผ่อนผันสั้น ๆ ให้แท็บที่สองตอบ 200 แบบไม่ตั้ง cookie ใหม่)
- logout / ลบผู้ใช้ / ปิดใช้งาน จะลบคีย์ทั้งหมดของ session (refresh token + ตัวนับ + index) ทันที

**การตัดสิทธิ์ (delete / ปิดใช้งาน / ย้าย role) มีผลเมื่อไร:**

| การกระทำของ HR | ผลกับคนนั้นทันที |
|---|---|
| ลบผู้ใช้ (`DELETE /users/{id}`) | คำขอถัดไปได้ **401** ทุกเส้นทางที่ใช้ session → หน้าเว็บพาไป `/login`, บันทึก session ใน Redis ถูกลบทันที |
| ปิดใช้งาน (`PATCH /users/{id}/status {is_active:false}`) | เหมือนการลบ (ยังไม่ลบแถวแต่ถูกตัดสิทธิ์เท่ากัน) และลบบันทึก session ทันที |
| เปลี่ยน role / ถอดสิทธิ์เมนู | มีผลกับคำขอถัดไปทันที ไม่ต้อง login ใหม่ (อ่านสิทธิ์จาก DB ทุกครั้ง) |
| refresh token เก่า | ถูกใช้ต่อไม่ได้ — คำขอ refresh ของคนที่ถูกตัดสิทธิ์ได้ 401 และทุกคีย์ของ session ถูกลบทิ้ง |

ด่านนี้คือ `session_is_live()` ใน `backend/app/dependencies.py` (เรียกจาก `get_current_user_id` และจาก
`POST /auth/refresh`) — เป็นการอ่าน `local_users` **1 ครั้งต่อคำขอ** ไม่มี cache เพราะถ้า cache แล้วการตัดสิทธิ์
จะช้า ฝั่งพนักงาน (LIFF) ก็ใช้เงื่อนไขเดียวกันใน `get_bound_employee` → คนที่ถูกลบ/ปิดใช้งานจะลงเวลาไม่ได้
(ได้ข้อความไทย "บัญชีพนักงานของคุณถูกปิดการใช้งานแล้ว กรุณาติดต่อฝ่ายบุคคล" และไม่มีการเขียนข้อมูลใด ๆ)

**สองจุดที่ควรรู้ (พฤติกรรมที่ตั้งใจ):**
- **เปิดใช้งานกลับ (re-activate)**: ในเบราว์เซอร์จริง ผู้ใช้ต้อง **login ใหม่** เพราะคำขอ refresh ที่ล้มเหลวระหว่างถูกตัดสิทธิ์
  ได้ล้าง cookie ทั้งคู่ไปแล้ว (ทดสอบจริงในเบราว์เซอร์ 2 session) แต่ถ้าเป็น client ที่ไม่สนใจ `Set-Cookie`
  (เช่นชุดทดสอบ API) access token เดิมยังใช้ได้จนหมดอายุ โดย refresh token ถูกลบไปแล้ว
  ส่วนกรณีลบแล้วสร้างใหม่ (re-provision) employee_id เดิม จะไม่รับ token ที่ออกก่อนการลบ
  (เทียบ `iat` กับ `created_at` ของแถวใหม่ — ยอมรับ clock skew 60 วินาที)
- **กันการล็อกตัวเองออก**: ลบ/ปิดใช้งานบัญชีตัวเอง หรือทำให้เหลือผู้ดูแลระบบ (role `Admin`) ที่ใช้งานอยู่น้อยกว่า 1 คน
  จะถูกปฏิเสธด้วยข้อความไทย และต้องเป็น role `Admin` เท่านั้นที่ถือว่าเป็นผู้ดูแลระบบ

> [!NOTE]
> ไม่มี token blacklist และไม่ได้เก็บ state เพิ่ม — การตัดสิทธิ์อาศัยข้อเท็จจริงในฐานข้อมูลเพียงอย่างเดียว
> ส่วน access token ที่ยังไม่หมดอายุ "ตาย" ตามด่านนี้ทุกคำขอ ไม่ต้องรอ exp

> [!NOTE]
> **งาน 028 แก้ข้อจำกัดเดิมของงาน 023 แล้ว:** เดิม cookie `access_token` มีอายุเท่ากับตัว token (15 นาที) ทำให้
> เบราว์เซอร์ทิ้ง cookie ก่อนที่ `/auth/refresh` จะได้ใช้ และ session ที่ idle ต้อง login ใหม่เสมอ ตอนนี้ cookie
> อยู่ได้ตลอดเพดาน session (60 นาที) แต่ตัว token ข้างในยังหมดอายุตาม Core-API และทุกเส้นทางที่ต้องยืนยันตัวตน
> ยังปฏิเสธ token ที่หมดอายุ (พิสูจน์ใน `028-report.md`) ข้อจำกัดที่เหลือ: (1) `ACCESS_TOKEN_EXPIRE_SECONDS`
> ในระบบนี้ (900 วินาที) เป็น "ข้อสมมติ" ของ WorkDee ไม่ใช่ค่าจริงของ Core-API ซึ่งวัดได้ 1800 วินาที — ถ้าจะแก้
> ให้ตรง ให้แก้ที่ `.env` ของ backend อย่างเดียว (เพดาน 60 นาทีไม่ผูกกับค่านี้แล้ว) (2) session ใหม่ใช้ระบบนี้
> ตั้งแต่วันที่ deploy — session ที่ login ก่อนหน้านั้นไม่มีตัวนับ จึงต้อง login ใหม่หนึ่งครั้ง

---

## 14. Runtime facts — สิ่งที่ต้องรู้ก่อน deploy (งาน 033)

หัวข้อนี้รวบข้อเท็จจริงที่ตรวจจากโค้ดจริง เมื่อ 2026-09-30 (งาน 033) — ใช้ตอบคำถามว่า “ของจริงเป็นอย่างไร”
โดยไม่ต้องไปอ่านโค้ดซ้ำ

### 14.1 บริการภายนอกที่ต้องมี

| บริการ | จำเป็น | ใช้ทำอะไร |
|---|---|---|
| PostgreSQL | ✅ | ฐานข้อมูลหลัก (`DATABASE_URL`) — startup สร้าง/ซ่อม schema เอง (ข้อ 14.4) |
| Redis | ✅ | เก็บ session และ refresh token (ข้อ 14.3) — ถ้า Redis ล่ม การ login และการต่ออายุจะไม่ทำงาน |
| FutureSign Core-API | ✅ | ยืนยันตัวตนและเป็นแหล่งข้อมูลพนักงาน (`CORE_API_URL`, `CORE_API_KEY`) ทุกคำขอที่ต้องยืนยันตัวตนจะถาม Core-API (`GET /api/v1/auth/me`) — Core-API ปิด = 401 |
| LINE Messaging API | ⬜ | ใช้เฉพาะฟีเจอร์ LINE (ผูกบัญชี, rich menu, push) ไม่ตั้งค่าก็ใช้ส่วนอื่นได้ — host แก้ได้ผ่าน `LINE_API_BASE`/`LINE_DATA_API_BASE` |
| Oracle | ❌ | **ไม่ใช้** — ข้อมูลพนักงานทั้งหมดมาจาก Core-API (ดู §3.1) |

### 14.2 พอร์ตที่ใช้

| สิ่งที่รัน | พอร์ตเริ่มต้น | หมายเหตุ |
|---|---|---|
| Frontend (dev) | 3019 | `npm run dev` → `next dev -p 3019` |
| Frontend (container) | 3000 | `ENV PORT=3000` ใน Dockerfile; compose map `${FRONTEND_PORT:-3019}:3000` |
| Backend (dev) | 8019 | `uvicorn app.main:app --port 8019` — §5 ใส่ `--reload` เป็นตัวเลือก; ถ้าไม่ใส่ ต้อง restart เองเมื่อแก้โค้ดใต้ `backend/app/` (route ใหม่จะยัง 404 จนกว่าจะ restart) |
| Backend (container) | 8000 | `CMD uvicorn … --port 8000` (ไม่มี `--reload`); compose map `${BACKEND_PORT:-8019}:8000` |
| PostgreSQL | 5432 | ตาม `DATABASE_URL` |
| Redis | 6379 | ตาม `REDIS_URL` |

### 14.3 คีย์ใน Redis ที่ session ใช้ (งาน 023/028)

| คีย์ | อายุ | เก็บอะไร |
|---|---|---|
| `<employee_id>:refresh_token` | `REFRESH_TOKEN_EXPIRE_SECONDS` (7 วัน) | refresh token ปัจจุบัน — ลบคีย์นี้ = ตัดสิทธิ์ทันที |
| `<employee_id>:session_meta` | `SESSION_MAX_AGE_MINUTES` (60 นาที) | ตัวนับ `renewals` และ `started_at` (รีเซ็ตทุกครั้งที่ login ใหม่) |
| `<employee_id>:refresh_fingerprints` | 7 วัน | ลายนิ้วมือของ token ที่ถูกหมุนไปแล้ว (ใช้ตรวจ refresh token เก่า) |
| `refresh_owner:<sha256>` | 7 วัน | index ย้อนกลับ: token → employee id (ใช้หาเจ้าของ session ตอน refresh/logout) |
| `refresh_prev:<sha256>` | 15 วินาที | เพิ่งหมุนไป — ให้แท็บที่สองได้คำตอบ “ต่ออายุแล้ว” ไม่ใช่ error |
| `refresh_renewed:<sha256>` | 15 วินาที | marker กันสองแท็บที่ต่ออายุพร้อมกันถูกนับเป็น 2 ครั้ง |

logout / ลบผู้ใช้ / ปิดใช้งาน / ครบโควตา → ลบคีย์ทั้งหมดของ session นั้นพร้อมกัน (ดู §13)

### 14.4 สิ่งที่ startup ทำกับฐานข้อมูล (ทุกครั้งที่ start, idempotent)

1. `Base.metadata.create_all` — สร้างตาราง/คอลัมน์ที่ยังไม่มี
2. `ALTER TABLE … ADD COLUMN IF NOT EXISTS`: `line_bindings.revoke_reason`, `app_settings.line_channel_access_token/line_channel_secret/line_liff_id/line_basic_id`, คอลัมน์ตรวจของ HR ใน `attendance_checkins`
3. ซ่อม `audit_logs` (เพิ่มคอลัมน์ที่ขาด) — **ไม่ drop ไม่สร้างใหม่** ประวัติเดิมจึงรอดทุกครั้งที่ start
4. `line_bindings`: สร้าง unique index ของคู่ที่ยัง active (1:1) และ drop unique **constraint แบบเก่า** ที่อาจค้างจาก install รุ่นก่อน
5. `attendance_checkins`: index “1 ครั้ง/รอบ/วัน” + index ของหน้าค้นหา (งาน 022)
6. `seed_data()` — เติมเมนู/สิทธิ์/ค่าเริ่มต้นที่ขาด (Admin ได้เมนูอัตโนมัติ) — ทำงานทุกครั้งที่ start
7. log 1 บรรทัดเรื่องโฟลเดอร์รูป (`photo storage ready at …` = INFO, ใช้ไม่ได้ = WARNING: แอปยัง start ได้)

> [!IMPORTANT]
> **Alembic มีอยู่ในโปรเจกต์ (`backend/alembic/`) แต่ไม่ถูกใช้กับฐานข้อมูลจริง** — ไม่มีตาราง `alembic_version`
> และ startup ไม่เรียก `alembic upgrade` การเปลี่ยน schema ระหว่างงานที่ผ่านมาจึงอยู่ในรูป `create_all` +
> inline `ALTER TABLE` (ข้อ 1-5) ถ้าจะเริ่มใช้ Alembic ต้องทำ baseline ให้ตรงกับ schema ปัจจุบันก่อน

### 14.5 เส้นทางที่ไม่ต้องล็อกอิน (frontend middleware)

`frontend/src/proxy.ts` (Next 16 middleware) ตรวจ cookie `access_token` **ทุกเส้นทาง** ยกเว้น:

| ผ่านได้เสมอ | เพราะ |
|---|---|
| `/login` | หน้าล็อกอินเอง |
| `/liff/**` | พนักงานเปิดจาก LINE และยืนยันตัวตนด้วย LINE ID token ไม่ใช่ session ของ dashboard |
| `/api/**`, `/_next/static/**`, `/_next/image/**`, `/favicon.ico` | ไม่อยู่ใน matcher ของ middleware |

ที่เหลือ (รวม `/dashboard/**` และ **`/theme-preview`**) ถ้าไม่มี cookie จะถูก redirect ไป `/login` และถ้ามี cookie
แล้วเปิด `/login` จะถูกพาไป `/dashboard`

### 14.6 ค่าที่ตั้งได้แต่ “ไม่มีผล”

| ค่า | สถานะ |
|---|---|
| `APP_ENV` | ไม่มีโค้ดส่วนไหนอ่าน (มีไว้บอกชื่อ environment เฉย ๆ) — ตัดสินใจว่าจะเก็บหรือเอาออกยังค้างอยู่ |
| `ACCESS_TOKEN_EXPIRE_SECONDS` | ไม่มีโค้ดส่วนไหนอ่านเช่นกัน — อายุ access token เป็นของ Core-API (วัดได้ 1800 วินาที) ส่วน cookie ของ WorkDee อายุเท่า `SESSION_MAX_AGE_MINUTES` (§13) |

---

*Last updated: 2026-09-30 | FutureSign Corporate Template v1.x*
