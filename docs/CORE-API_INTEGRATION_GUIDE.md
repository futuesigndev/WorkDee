# Core-API — Integration Guide

คู่มือสำหรับ Developer ที่ต้องการเชื่อมต่อกับ Core API  
เวอร์ชัน: v1 · ปรับปรุงล่าสุด: เมษายน 2026

---

## สารบัญ

1. [Base URL](#base-url)
2. [Authentication (สำคัญมาก — อ่านก่อน)](#authentication)
3. [Headers ที่ต้องส่งทุก Request](#headers)
4. [Error Format](#error-format)
5. [Rate Limiting](#rate-limiting)
6. [Endpoints](#endpoints)
   - [Auth — Login / Token](#auth--login--token)
   - [Auth — User Info](#auth--user-info)
   - [Employees](#employees)
   - [Health Check](#health-check)
7. [Code Examples](#code-examples)
8. [ขอ API Key](#ขอ-api-key)

---

## Base URL

| Environment | URL |
|-------------|-----|
| **Production** | `https://core-api.futuresign.co.th` |
| **Local Dev** | `http://localhost:8006` |

> Swagger UI: `{BASE_URL}/docs` — ลองเรียก API ได้ทันทีในเบราว์เซอร์

---

## Authentication

Core API ใช้ **Double-Layer Security**:

```
Layer 1 — X-API-Key header   → ระบุว่า Application ไหนกำลังเรียก
Layer 2 — JWT Bearer token   → ระบุว่า User คนไหนกำลังใช้งาน
```

ทุก request ต้องมี **Layer 1** เสมอ  
Endpoint ที่ต้องการข้อมูล User ต้องมี **Layer 2** ด้วย

### Layer 1 — X-API-Key

แต่ละ Application จะได้รับ API Key 1 ชุด (format: `fsc_live_xxxxxxxxxx`)  
ใส่ใน header ทุก request:

```
X-API-Key: fsc_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ ห้าม hardcode key ใน source code — ใช้ environment variable

### Layer 2 — JWT Bearer Token

ได้มาจาก `/api/v1/auth/login` หรือ `/api/v1/auth/rfid`  
ใส่ใน Authorization header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Token Lifetime:**
| Token | อายุ |
|-------|------|
| `access_token` | 15 นาที |
| `refresh_token` | 7 วัน |

เมื่อ access_token หมดอายุ ให้เรียก `/api/v1/auth/refresh` เพื่อรับ token ใหม่ (ไม่ต้อง login ใหม่)

---

## Headers

```http
X-API-Key: fsc_live_xxxxxxxxxx          (ทุก request)
Authorization: Bearer <access_token>    (request ที่ต้อง login)
Content-Type: application/json          (request ที่มี body)
```

---

## Error Format

Response เมื่อเกิด error จะมีรูปแบบเดิมเสมอ:

```json
{
  "error_code": "INVALID_CREDENTIALS",
  "message": "Invalid employee ID or password",
  "detail": null
}
```

| HTTP Status | ความหมาย |
|-------------|----------|
| `400` | Request ไม่ถูกต้อง (validation error) |
| `401` | API Key ไม่ถูกต้อง หรือ Token หมดอายุ / ไม่มี |
| `403` | Token ถูกต้องแต่ไม่มีสิทธิ์ (role ไม่พอ) |
| `404` | ไม่พบข้อมูล |
| `422` | Request body ผิด format (Pydantic validation) |
| `429` | ส่ง request ถี่เกินไป (rate limited) |
| `500` | Server error |
| `501` | Feature ยังไม่เปิดให้ใช้ |

**Common error codes:**

| error_code | สาเหตุ |
|------------|--------|
| `INVALID_CREDENTIALS` | employee_id หรือ password ผิด |
| `ACCOUNT_LOCKED` | login ผิดเกิน 5 ครั้ง — ต้องรอ 15 นาที |
| `INVALID_TOKEN` | JWT หมดอายุ หรือถูก revoke |
| `API_KEY_INVALID` | X-API-Key ผิด หรือถูก revoke |
| `SCOPE_DENIED` | API Key ไม่มี scope ที่ต้องการ |
| `NOT_FOUND` | ไม่พบ resource ที่ขอ |
| `RATE_LIMITED` | ส่ง request ถี่เกินไป |

---

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `/auth/login` | 10 req / นาที ต่อ IP |
| `/auth/rfid` | 20 req / นาที ต่อ IP |
| อื่นๆ | ไม่มี limit (ตาม client config) |

เมื่อ rate limited จะได้รับ:
```http
HTTP 429 Too Many Requests
Retry-After: 60
```

---

## Endpoints

---

### Auth — Login / Token

#### `POST /api/v1/auth/login`

Login ด้วย employee_id + password  
รองรับทั้ง Active Directory (GRADE > 1) และ LOCAL auth (GRADE ≤ 1)

**Required Scope:** `auth:login`  
**Auth:** X-API-Key เท่านั้น (ไม่ต้องมี JWT)

**Request:**
```json
{
  "employee_id": "EMP001",
  "password": "YourPassword123"
}
```

**Response `200 OK`:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 900,
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "user": {
    "employee_id": "EMP001",
    "full_name": "สมชาย ใจดี",
    "role": "operator",
    "auth_provider": "AD",
    "is_first_login": false,
    "department": "Production",
    "company": "FutureSign Co., Ltd."
  }
}
```

> ⚠️ ถ้า `is_first_login: true` ระบบต้องบังคับให้ user เปลี่ยน password ก่อนใช้งาน

---

#### `POST /api/v1/auth/rfid`

Login ด้วย RFID badge — ไม่ต้องใส่ password

**Required Scope:** `auth:login`  
**Auth:** X-API-Key เท่านั้น

**Request:**
```json
{
  "rfid_no": "A1B2C3D4"
}
```

**Response:** เหมือนกับ `/auth/login`

---

#### `POST /api/v1/auth/refresh`

รับ access_token ใหม่ โดยไม่ต้อง login ซ้ำ  
ใช้เมื่อ access_token หมดอายุ (HTTP 401)

**Auth:** X-API-Key เท่านั้น

**Request:**
```json
{
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Response `200 OK`:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "bmV3UmVmcmVzaFRva2Vu...",
  "token_type": "bearer",
  "expires_in": 900
}
```

> Refresh token จะถูก rotate ทุกครั้ง — เก็บ token ใหม่ที่ได้ไว้เสมอ

---

#### `POST /api/v1/auth/logout`

Revoke refresh token ของ session ปัจจุบัน

**Auth:** X-API-Key + JWT Bearer

**Request:**
```json
{
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Response `204 No Content`**

---

#### `POST /api/v1/auth/logout-all`

Revoke ทุก session ของ user คนนี้ (ทุกอุปกรณ์)

**Auth:** X-API-Key + JWT Bearer

**Request:** ไม่มี body

**Response `200 OK`:**
```json
{
  "revoked": 3
}
```

---

#### `POST /api/v1/auth/change-pwd`

เปลี่ยน password — ใช้ได้เฉพาะ LOCAL users (GRADE ≤ 1)  
AD users ต้องเปลี่ยน password ผ่าน Windows/AD

**Auth:** X-API-Key + JWT Bearer

**Request:**
```json
{
  "old_password": "OldPassword123",
  "new_password": "NewPassword456"
}
```

**Response `204 No Content`**

---

### Auth — User Info

#### `GET /api/v1/auth/me`

ดึงข้อมูล profile ของ user ที่ login อยู่

**Auth:** X-API-Key + JWT Bearer

**Response `200 OK`:**
```json
{
  "employee_id": "EMP001",
  "full_name": "สมชาย ใจดี",
  "nick_name": "ชาย",
  "role": "operator",
  "grade": 3.0,
  "auth_provider": "AD",
  "section": "Assembly",
  "department": "Production",
  "division": "Manufacturing",
  "company": "FutureSign Co., Ltd.",
  "company_abb": "FS",
  "hire_date": "2020-05-15",
  "cost_center": "CC001"
}
```

**Role values:** `admin` · `manager` · `operator`  
**auth_provider values:** `AD` · `LOCAL` · `RFID`

---

### Employees

> ต้องมี scope `employees:read` ใน API Key

#### `GET /api/v1/employees`

ค้นหาและดูรายชื่อพนักงาน พร้อม filter และ pagination

**Auth:** X-API-Key + JWT Bearer

**Query Parameters:**

| Parameter | Type | คำอธิบาย |
|-----------|------|----------|
| `q` | string | ค้นหาจาก employee_id, ชื่อ, ชื่อเล่น |
| `active` | boolean | `true` = active only, `false` = inactive only |
| `department` | string | กรองตาม department (ตรงทั้งหมด) |
| `division` | string | กรองตาม division |
| `section` | string | กรองตาม section |
| `company_abb` | string | กรองตาม company abbreviation เช่น `FS` |
| `auth_provider` | string | กรองตาม auth type: `AD`, `LOCAL` |
| `grade` | integer | กรองตาม grade (1–9) |
| `no_rfid` | boolean | `true` = แสดงเฉพาะคนที่ยังไม่มี RFID |
| `limit` | integer | จำนวนผลต่อหน้า (default: 20, max: 100) |
| `offset` | integer | ข้าม N แถวแรก (default: 0) |

**Example:**
```
GET /api/v1/employees?q=สมชาย&active=true&limit=10
```

**Response `200 OK`:**
```json
{
  "items": [
    {
      "employee_id": "EMP001",
      "full_name": "สมชาย ใจดี",
      "nick_name": "ชาย",
      "grade": 3.0,
      "active": true,
      "department": "Production",
      "division": "Manufacturing",
      "company_abb": "FS",
      "auth_provider": "AD",
      "rfid_no": "A1B2C3D4"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

---

#### `GET /api/v1/employees/{employee_id}`

ดูข้อมูลพนักงานแบบครบถ้วนตาม ID

**Auth:** X-API-Key + JWT Bearer

**Response `200 OK`:**
```json
{
  "employee_id": "EMP001",
  "full_name": "สมชาย ใจดี",
  "nick_name": "ชาย",
  "grade": 3.0,
  "active": true,
  "section": "Assembly",
  "department": "Production",
  "division": "Manufacturing",
  "company_name": "FutureSign Co., Ltd.",
  "company_abb": "FS",
  "hire_date": "2020-05-15",
  "cost_center": "CC001"
}
```

---

### Health Check

ไม่ต้องการ Authentication ใดๆ

#### `GET /api/v1/health`

Liveness probe — ตรวจสอบว่า process ยังทำงานอยู่

**Response `200 OK`:**
```json
{
  "status": "ok",
  "uptime_seconds": 3600.5
}
```

---

#### `GET /api/v1/health/detail`

Readiness probe — ตรวจสอบ DB, Redis, และ Circuit Breaker

**Response `200 OK`:**
```json
{
  "status": "ok",
  "components": {
    "redis": { "status": "ok", "detail": null },
    "database": { "status": "ok", "detail": null }
  },
  "circuit_breaker": "closed"
}
```

`status` values: `ok` · `degraded`  
`circuit_breaker` values: `closed` (normal) · `open` (blocking) · `half_open` (recovering)

---

## Code Examples

### JavaScript / TypeScript

```typescript
const BASE_URL = "https://core-api.futuresign.co.th";
const API_KEY  = process.env.CORE_API_KEY; // "fsc_live_xxxx..."

// 1. Login
async function login(employeeId: string, password: string) {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ employee_id: employeeId, password }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message);
  }

  const data = await res.json();
  // Store tokens securely
  localStorage.setItem("access_token", data.access_token);
  localStorage.setItem("refresh_token", data.refresh_token);
  return data.user;
}

// 2. Authenticated request (with auto-refresh)
async function apiCall(path: string, options: RequestInit = {}) {
  const makeRequest = (token: string) =>
    fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        "X-API-Key": API_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

  let token = localStorage.getItem("access_token")!;
  let res = await makeRequest(token);

  // Access token expired — try refresh
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (!refreshed) throw new Error("Session expired — please login again");
    token = localStorage.getItem("access_token")!;
    res = await makeRequest(token);
  }

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message);
  }

  return res.json();
}

// 3. Refresh token
async function refreshToken(): Promise<boolean> {
  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) return false;

  const res = await fetch(`${BASE_URL}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) return false;

  const data = await res.json();
  localStorage.setItem("access_token", data.access_token);
  localStorage.setItem("refresh_token", data.refresh_token);
  return true;
}

// 4. Get employee list
async function getEmployees(query?: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("limit", "20");
  return apiCall(`/api/v1/employees?${params}`);
}
```

---

### Python

```python
import httpx
import os

BASE_URL = "https://core-api.futuresign.co.th"
API_KEY  = os.environ["CORE_API_KEY"]  # "fsc_live_xxxx..."


class CoreApiClient:
    def __init__(self):
        self.client = httpx.Client(
            base_url=BASE_URL,
            headers={"X-API-Key": API_KEY},
            timeout=10.0,
        )
        self.access_token: str | None = None
        self.refresh_token_value: str | None = None

    def login(self, employee_id: str, password: str) -> dict:
        res = self.client.post("/api/v1/auth/login", json={
            "employee_id": employee_id,
            "password": password,
        })
        res.raise_for_status()
        data = res.json()
        self.access_token = data["access_token"]
        self.refresh_token_value = data["refresh_token"]
        return data["user"]

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}"}

    def refresh(self) -> bool:
        if not self.refresh_token_value:
            return False
        res = self.client.post("/api/v1/auth/refresh", json={
            "refresh_token": self.refresh_token_value,
        })
        if not res.is_success:
            return False
        data = res.json()
        self.access_token = data["access_token"]
        self.refresh_token_value = data["refresh_token"]
        return True

    def get(self, path: str, **params) -> dict:
        res = self.client.get(path, headers=self._auth_headers(), params=params)
        if res.status_code == 401:
            if self.refresh():
                res = self.client.get(path, headers=self._auth_headers(), params=params)
        res.raise_for_status()
        return res.json()

    def get_employees(self, q: str | None = None, active: bool | None = None) -> dict:
        params = {}
        if q:
            params["q"] = q
        if active is not None:
            params["active"] = str(active).lower()
        return self.get("/api/v1/employees", **params)


# Usage
api = CoreApiClient()
api.login("EMP001", "Password123")
employees = api.get_employees(q="สมชาย", active=True)
print(employees["items"])
```

---

### cURL

```bash
# Login
curl -s -X POST https://core-api.futuresign.co.th/api/v1/auth/login \
  -H "X-API-Key: fsc_live_xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"employee_id": "EMP001", "password": "Password123"}' | jq

# ใช้ token จาก login ด้านบน
ACCESS_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Get my profile
curl -s https://core-api.futuresign.co.th/api/v1/auth/me \
  -H "X-API-Key: fsc_live_xxxxxx" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq

# Search employees
curl -s "https://core-api.futuresign.co.th/api/v1/employees?q=สมชาย&active=true" \
  -H "X-API-Key: fsc_live_xxxxxx" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

---

## ขอ API Key

ติดต่อทีม Dev เพื่อขอ API Key สำหรับ application ของคุณ พร้อมระบุ:

1. **ชื่อ Application** — เช่น `ERP Integration`, `RFID Terminal`
2. **Scopes ที่ต้องการ** — ดู [รายการ Scopes](#scopes-ทั้งหมด) ด้านล่าง
3. **IP ที่จะใช้งาน** — ถ้าต้องการจำกัดการเข้าถึง

---

### Scopes ทั้งหมด

| Scope | คำอธิบาย |
|-------|----------|
| `auth:login` | Login ด้วย Password หรือ RFID Badge |
| `employees:read` | อ่านข้อมูลพนักงาน / ค้นหา |
| `employees:write` | เพิ่ม / แก้ไขข้อมูลพนักงาน |
| `clients:read` | ดูรายการ Client Application |
| `clients:write` | สร้าง / แก้ไข Client Application |
| `apikeys:read` | ดูรายการ API Key |
| `apikeys:write` | สร้าง / Rotate / Revoke API Key |
| `audit:read` | ดู Audit Log |
| `customers:read` | ค้นหาและดูข้อมูลลูกค้า |
| `customers:write` | แก้ไขข้อมูลลูกค้า |
| `health:read` | ตรวจสอบสถานะระบบ |

> ขอเฉพาะ scope ที่จำเป็น — หลัก Least Privilege

---

## ข้อควรระวัง

- **ห้ามเก็บ API Key หรือ token ใน source code** — ใช้ environment variable เสมอ
- **ห้ามเก็บ token ใน `localStorage` สำหรับ web app ที่ sensitive** — ใช้ `httpOnly cookie` แทน
- `access_token` หมดอายุใน 15 นาที — implement auto-refresh ไม่งั้น user จะถูก logout กลางคัน
- `refresh_token` จะถูก rotate ทุกครั้งที่ใช้ — เก็บ token ใหม่ทุกครั้ง
- Login ผิด 5 ครั้งติดต่อกัน account จะถูกล็อก 15 นาที
