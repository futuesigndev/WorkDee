# System Specification: Multi-Application Webapp Template

**เวอร์ชัน:** 1.4 · **สถานะ:** ร่างข้อกำหนดการออกแบบ (System Architecture & Functional Specs)
**อัปเดตล่าสุด:** 2025 · **ผู้รับผิดชอบ:** FutureSign Platform Team

---

## สารบัญ (Table of Contents)

1. [ขอบเขตของระบบ](#1-ขอบเขตของระบบ)
2. [สถาปัตยกรรมและการเชื่อมต่อข้อมูล](#2-สถาปัตยกรรมและการเชื่อมต่อข้อมูล)
3. [รายละเอียดข้อกำหนดทางเทคนิค](#3-รายละเอียดข้อกำหนดทางเทคนิค)
   - 3.1 [ระบบยืนยันตัวตนและความปลอดภัยส่วนกลาง](#ข้อกำหนดที่-31-ระบบยืนยันตัวตนและความปลอดภัยส่วนกลาง-hybrid-authentication)
   - 3.2 [ระบบเพิ่มผู้ใช้งานและ Deprovisioning](#ข้อกำหนดที่-32-ระบบเพิ่มผู้ใช้งานและ-deprovisioning)
   - 3.3 [ระบบจัดการบทบาทและสิทธิ์เข้าถึงเมนูแบบไดนามิก](#ข้อกำหนดที่-33-ระบบจัดการบทบาทและสิทธิ์เข้าถึงเมนูแบบไดนามิก-dynamic-menu--rbac)
   - 3.4 [ระบบผูกสิทธิ์ LINE OA](#ข้อกำหนดที่-34-ระบบตรวจสอบและผูกสิทธิ์-line-oa-key-security-control)
   - 3.5 [ระบบปรับแต่งโทนสีและภาพลักษณ์](#ข้อกำหนดที่-35-ระบบปรับแต่งโทนสีและภาพลักษณ์หน้าเว็บ-dynamic-theme-engine)
   - 3.6 [Audit Log & Event Matrix](#ข้อกำหนดที่-36-ระบบ-audit-log--event-matrix)
   - 3.7 [Rate Limiting & API Protection](#ข้อกำหนดที่-37-rate-limiting--api-protection)
   - 3.8 [CSRF Protection](#ข้อกำหนดที่-38-csrf-protection)
   - 3.9 [WebSocket Specification](#ข้อกำหนดที่-39-websocket-specification)
   - 3.10 [Webhook Signature Verification](#ข้อกำหนดที่-310-webhook-signature-verification)
   - 3.11 [Error Handling & API Response Standard](#ข้อกำหนดที่-311-error-handling--api-response-standard)
   - 3.12 [Input Validation & Sanitization](#ข้อกำหนดที่-312-input-validation--sanitization)
   - 3.13 [Redis Fault Tolerance](#ข้อกำหนดที่-313-redis-fault-tolerance)
   - 3.14 [Time Zone Standard](#ข้อกำหนดที่-314-time-zone-standard)
   - 3.15 [ระบบการตั้งชื่อและการกำหนดค่าแอปพลิเคชัน](#ข้อกำหนดที่-315-ระบบการตั้งชื่อและการกำหนดค่าแอปพลิเคชัน-app-identity--settings)
   - 3.16 [LINE Push Notification Mode](#ข้อกำหนดที่-316-line-push-notification-mode)
4. [ข้อกำหนดการติดตั้งและการพัฒนา](#4-ข้อกำหนดการติดตั้งและการพัฒนา-deployment--devops-specifications)
   - 4.1 [Docker Containerization](#41-docker-containerization)
   - 4.2 [Local Mock Mode](#42-local-mock-mode)
   - 4.3 [Health Check Endpoints](#43-health-check-endpoints)
   - 4.4 [Environment Variables ใน Next.js Standalone Build](#44-environment-variables-ใน-nextjs-standalone-build)
5. [Seed Script & Migration Strategy](#5-seed-script--migration-strategy)
   - 5.1 [Migration Strategy (Alembic)](#51-migration-strategy-alembic)
   - 5.2 [Alembic Migration Branching Strategy](#52-alembic-migration-branching-strategy)
   - 5.3 [Seed Script](#53-seed-script)
6. [Security Checklist สรุป](#6-security-checklist-สรุป)

---

## 1. ขอบเขตของระบบ (System Scope)

เทมเพลตนี้ทำหน้าที่เป็นโครงสร้างตั้งต้น **(Boilerplate)** สำหรับการพัฒนา Web Dashboard ภายในองค์กร ประกอบด้วยส่วนของ:

| ชั้น | เทคโนโลยี | หน้าที่หลัก |
|---|---|---|
| Frontend | Next.js 15+, React 19, Tailwind CSS v4 | UI Rendering, Routing, Theme Engine |
| Backend | FastAPI, SQLAlchemy 2, Alembic | REST API, Auth Bridge, Business Logic |
| Database | PostgreSQL (App Data), Redis 7 (Session/Cache) | Persistence, Rate Limiting, Token Store |
| Integration | Core-API (FutureSign Central), LINE Messaging API | Identity Provider, Push Notification |

ระบบถูกออกแบบให้ **โคลนแล้วใช้งานได้ทันที** พร้อมระบบรักษาความปลอดภัย การจัดการสิทธิ์ภายใน การผูกสิทธิ์ LINE OA และระบบปรับแต่งหน้าตา (Theme) โดยไม่ต้องเขียนโค้ดพื้นฐานใหม่

---

## 2. สถาปัตยกรรมและการเชื่อมต่อข้อมูล (System Architecture)

### 2.1 แผนภาพการไหลของข้อมูล (Data Flow Overview)

```
[Next.js Frontend] ◄──(HttpOnly Cookie + CSRF Token)──► [FastAPI Backend]
        │                                                        │
        │ (REST / WebSocket)                   ┌────────────────┼─────────────────────┐
        ▼                                      ▼                ▼                     ▼
[LINE OA / LIFF]              [Redis 7]            [PostgreSQL Local DB]     [Core-API ส่วนกลาง]
(Webview/Webhook)       (Session, Rate Limit,     (local_users, roles,     (X-API-Key + JWT)
                          Token Blocklist)          menus, line_bindings,        │
                                                      audit_logs)           [nexus_db]
                                                                           (AD / LOCAL User)
```

### 2.2 โครงสร้างฐานข้อมูลภายในแอปย่อย (Local Database Schema)

ทุกครั้งที่โคลนแอปย่อยไปใช้ ระบบจะสร้างตารางพื้นฐานเหล่านี้ผ่าน **Alembic Migration** โดยอัตโนมัติ:

#### ตาราง `local_users`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `employee_id` | VARCHAR (Unique) | รหัสพนักงานจาก Core-API |
| `full_name` | VARCHAR | ชื่อ-นามสกุล |
| `department` | VARCHAR | แผนก |
| `division` | VARCHAR | ฝ่าย |
| `company` | VARCHAR | บริษัท |
| `role_id` | UUID (FK → local_roles) | บทบาทภายในแอปย่อย |
| `is_active` | BOOLEAN | สถานะการใช้งาน |
| `deprovisioned_at` | TIMESTAMP | วันที่ถูกยกเลิกสิทธิ์ |
| `created_at` | TIMESTAMP | วันที่เพิ่มเข้าระบบ |
| `updated_at` | TIMESTAMP | วันที่อัปเดตล่าสุด |

#### ตาราง `local_roles`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `name` | VARCHAR (Unique) | ชื่อบทบาท (เช่น Admin, Supervisor) |
| `description` | TEXT | คำอธิบายบทบาท |
| `is_system_role` | BOOLEAN | บทบาทระดับระบบ (ลบไม่ได้) |

#### ตาราง `local_menus`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `key` | VARCHAR (Unique) | รหัสเมนู เช่น `dashboard`, `report` |
| `label` | VARCHAR | ชื่อแสดงผล |
| `path` | VARCHAR | URL Path |
| `icon` | VARCHAR | ชื่อไอคอน |
| `parent_id` | UUID (FK Self) | เมนูแม่ (สำหรับ Sub-menu) |
| `order` | INTEGER | ลำดับการแสดงผล |
| `is_active` | BOOLEAN | เปิด/ปิดเมนูชั่วคราวโดยไม่ต้องลบออกจาก DB |

#### ตาราง `role_menu_permissions`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `role_id` | UUID (FK) | อ้างอิง local_roles |
| `menu_id` | UUID (FK) | อ้างอิง local_menus |
| `can_access` | BOOLEAN | มีสิทธิ์เข้าถึงหรือไม่ |

> **หมายเหตุ:** ต้องกำหนด `UNIQUE(role_id, menu_id)` ใน Migration เพื่อป้องกัน duplicate permission entry

#### ตาราง `line_bindings`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `line_user_id` | VARCHAR | LINE User ID |
| `line_display_name` | VARCHAR | ชื่อแสดงใน LINE |
| `employee_id` | VARCHAR (FK) | รหัสพนักงาน |
| `status` | ENUM | `Pending` / `Approved` / `Revoked` |
| `approved_by` | VARCHAR | รหัสพนักงานผู้อนุมัติ |
| `approved_at` | TIMESTAMP | วันที่อนุมัติ |
| `revoked_reason` | TEXT | เหตุผลการ Revoke |
| `created_at` | TIMESTAMP | วันที่สร้าง |

> **หมายเหตุ:** ต้องสร้าง Index บนคอลัมน์ `line_user_id` และ `employee_id` ใน Migration เนื่องจากทั้งสองคอลัมน์ถูก query บ่อยในกระบวนการ Approval และ Revocation

#### ตาราง `app_settings`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `app_name` | VARCHAR | ชื่อแอปพลิเคชัน (แสดงใน UI) |
| `app_logo_url` | VARCHAR (Nullable) | URL ของโลโก้ |
| `theme` | VARCHAR | ธีมปัจจุบัน เช่น `minimalist-slate` |
| `dark_mode` | VARCHAR | `system` / `light` / `dark` |
| `timezone_display` | VARCHAR | Timezone สำหรับแสดงผล เช่น `Asia/Bangkok` |
| `updated_by` | VARCHAR (Nullable) | employee_id ที่แก้ไขล่าสุด |
| `updated_at` | TIMESTAMPTZ | วันที่อัปเดตล่าสุด (UTC) |

> **หมายเหตุ:** ตารางนี้มีเพียง **1 Row เสมอ** สร้างโดย Seed Script ตอน init และ Admin แก้ไขผ่าน UI ได้ภายหลัง

#### ตาราง `audit_logs`
| คอลัมน์ | ชนิดข้อมูล | คำอธิบาย |
|---|---|---|
| `id` | UUID (PK) | Primary Key |
| `event_type` | VARCHAR | ประเภท Event (ดู Event Matrix ใน 3.6) |
| `actor_employee_id` | VARCHAR | ผู้ดำเนินการ |
| `target_employee_id` | VARCHAR (Nullable) | เป้าหมาย (ถ้ามี) |
| `metadata` | JSONB | ข้อมูลเพิ่มเติม (IP, User-Agent, ฯลฯ) |
| `created_at` | TIMESTAMP | Timestamp ของ Event (UTC) |

---

## 3. รายละเอียดข้อกำหนดทางเทคนิค (Functional & Technical Specifications)

---

### ข้อกำหนดที่ 3.1: ระบบยืนยันตัวตนและความปลอดภัยส่วนกลาง (Hybrid Authentication)

เทมเพลตต้องรองรับระบบยืนยันตัวตนสองชั้นที่เชื่อมต่อกับ Core-API และแปลงสิทธิ์เป็นระบบที่มีความปลอดภัยสูงขึ้นที่ฝั่งหน้าบ้าน

#### Double-Layer Security Bridge

```
Browser ──[HTTPS + HttpOnly Cookie]──► FastAPI ──[X-API-Key + JWT Header]──► Core-API
```

| ชั้น | กลไก | จุดประสงค์ |
|---|---|---|
| Layer 1 | X-API-Key ใน Environment Variable | ยืนยันตัวตนของแอปย่อยต่อ Core-API |
| Layer 2 | JWT แปลงเป็น HttpOnly Cookie | ป้องกัน XSS ไม่ให้ JavaScript เข้าถึง Token |

**Cookie Security Settings:**

```
HttpOnly = true
Secure = true          # บังคับ HTTPS เท่านั้น
SameSite = Lax         # ป้องกัน CSRF จาก cross-site request
Path = /
Max-Age = 900          # 15 นาที (Access Token)
```

#### Hybrid Authentication Flow

```
1. User กรอก employee_id + password หรือแตะ RFID
2. FastAPI รับคำขอ → ส่งต่อไปยัง Core-API (/auth/login หรือ /auth/rfid)
3. Core-API ตรวจสอบสิทธิ์ → ส่ง JWT กลับมา
4. FastAPI แปลง JWT → HttpOnly Cookie → ส่งกลับบราวเซอร์
5. FastAPI บันทึก Refresh Token ลงใน Redis พร้อมคีย์ employee_id:refresh_token
6. หน้าบ้านรับ Cookie และดึงข้อมูล User Profile จาก API
```

**หมายเหตุเรื่อง Refresh Token Storage:**
- Refresh Token จะถูกเก็บทั้งใน **Redis** (ฝั่ง Server) และ **HttpOnly Cookie** (ฝั่ง Browser)
- เมื่อต้องการ Force Logout หรือ Revoke Session → ลบ Key ใน Redis ทันที Cookie ที่เหลืออยู่จะใช้งานไม่ได้
- ทำให้รองรับ **Immediate Session Revocation** ได้โดยไม่ต้องรอ Token หมดอายุ

#### Auto-Refresh Token Mechanism

```
Access Token TTL  = 15 นาที
Refresh Token TTL = 7 วัน

Flow:
  API Response 401 ──► FastAPI Middleware ตรวจจับ
      │
      ▼
  ดึง Refresh Token จาก Cookie
      │
      ├─ ตรวจสอบ Redis → พบ Key → ต่ออายุได้
      │       ▼
      │   POST /auth/refresh → Core-API
      │       ▼
      │   อัปเดต Access Token Cookie ใหม่
      │       ▼
      │   Retry Request เดิม
      │
      └─ ไม่พบ Key ใน Redis → Force Logout → Redirect /login
```

#### Brute-force Protection

| พารามิเตอร์ | ค่า |
|---|---|
| Max Login Attempts | 5 ครั้งติดต่อกัน |
| Lockout Duration | 15 นาที |
| Storage | Redis (`lockout:{employee_id}`) |
| Reset Policy | รีเซ็ตอัตโนมัติหลัง Lockout หมดอายุ หรือ Admin ปลดล็อกด้วยตนเอง |

---

### ข้อกำหนดที่ 3.2: ระบบเพิ่มผู้ใช้งานและ Deprovisioning

#### Pull-based Provisioning (เพิ่มผู้ใช้ใหม่)

```
Admin กรอก employee_id
        │
        ▼
FastAPI → GET /api/v1/employees/{employee_id} ไปยัง Core-API
        │
        ▼
แสดงข้อมูลจริง (ชื่อ, แผนก, ฝ่าย, บริษัท) ให้ Admin ยืนยัน
        │
        ▼
บันทึกลง local_users + กำหนด Default Role
        │
        ▼
บันทึก Audit Log: EVENT_USER_PROVISIONED
```

#### User Deprovisioning (ยกเลิกสิทธิ์)

กรณีที่ต้องทำ Deprovisioning:
- พนักงานลาออกหรือถูกย้ายออกจากโปรเจกต์
- Core-API แจ้งว่า Employee Status เปลี่ยนเป็น `Inactive`
- Admin ดำเนินการด้วยตนเองผ่านหน้า User Management

**กระบวนการ Deprovisioning:**

```
1. ตั้งค่า local_users.is_active = false
2. ตั้งค่า local_users.deprovisioned_at = NOW()
3. Revoke Refresh Token ใน Redis ทันที (Force Logout)
4. ตั้งสถานะ line_bindings เป็น Revoked (ถ้ามี)
5. บันทึก Audit Log: EVENT_USER_DEPROVISIONED
```

#### Core-API Sync Policy

| สถานการณ์ | การดำเนินการ |
|---|---|
| Core-API แจ้ง Employee ถูก Deactivate | Webhook → Auto Deprovision |
| พนักงานย้ายแผนก | อัปเดต `department`, `division` ใน `local_users` แต่ **คง Role เดิม** ไว้ (Admin ต้องปรับเองถ้าจำเป็น) |
| Sync Policy | Pull-on-demand (ดึงข้อมูลเมื่อ Provision) + Webhook สำหรับ Deactivation |

---

### ข้อกำหนดที่ 3.3: ระบบจัดการบทบาทและสิทธิ์เข้าถึงเมนูแบบไดนามิก (Dynamic Menu & RBAC)

#### Menu Registry & Access Matrix

- แอดมินสร้างบทบาทภายในแอปย่อย (Local Roles) ได้ไม่จำกัด
- กำหนดสิทธิ์รายเมนูผ่านหน้าจอแบบ **Permission Matrix** (ตาราง Role × Menu)
- บทบาท System Role (เช่น `Super Admin`) ถูกกำหนดในระดับ Seed Data และลบไม่ได้

**ตัวอย่าง Permission Matrix:**

| เมนู | Super Admin | Supervisor | Operator |
|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ |
| Report | ✅ | ✅ | ❌ |
| User Management | ✅ | ❌ | ❌ |
| LINE OA Settings | ✅ | ❌ | ❌ |
| System Settings | ✅ | ❌ | ❌ |

#### Dynamic UI Rendering (Next.js)

```
Login สำเร็จ
     │
     ▼
GET /api/me/menus → FastAPI คืนเฉพาะเมนูที่ Role นั้นมีสิทธิ์
     │
     ▼
Next.js สร้าง Sidebar จากเมนูที่ได้รับ (ไม่แสดงเมนูที่ไม่มีสิทธิ์)
     │
     ▼
เก็บ Menu Permission ไว้ใน React Context / Zustand Store
```

#### Two-Way Router Guard

**Frontend Guard (Next.js Middleware):**
```
ผู้ใช้เข้า URL ตรง เช่น /report
     │
     ▼
Next.js Middleware ตรวจ Cookie → Decode Role
     │
     ├─ มีสิทธิ์ → แสดงหน้า
     └─ ไม่มีสิทธิ์ → แสดงหน้า 403 Forbidden
```

**Backend API Guard (FastAPI Dependency Injection):**
```python
# ทุก Endpoint ต้องใช้ Dependency นี้
@router.get("/report/data")
async def get_report(user = Depends(require_permission("report"))):
    ...
```
- ป้องกันการดัดแปลง Frontend เพื่อเรียก API โดยตรง
- ตรวจสอบสิทธิ์ทั้ง **Role** และ **Menu Permission** ในระดับ API

---

### ข้อกำหนดที่ 3.4: ระบบตรวจสอบและผูกสิทธิ์ LINE OA (Key Security Control)

#### กระบวนการลงทะเบียนผ่าน LINE (User Onboarding Flow)

```
พนักงานสแกน QR Code → เปิด LIFF/Webview ใน LINE
        │
        ▼
ระบบรับ LINE User ID + Display Name จาก LINE Profile API
        │
        ▼
FastAPI สร้างรายการใน line_bindings สถานะ "Pending"
        │
        ▼
บันทึก Audit Log: EVENT_LINE_BINDING_REQUESTED
```

#### กระบวนการอนุมัติ (Admin Approval Flow)

```
Admin เปิดหน้า Setting → LINE OA Settings
        │
        ▼
ดูรายการ Pending Requests
        │
        ▼
ค้นหาและเลือกจับคู่กับ employee_id ในระบบ
        │
        ▼
กด Approve
        │
        ▼
ระบบ:
  1. เปลี่ยนสถานะเป็น "Approved"
  2. Revoke line_bindings เก่า (ถ้ามี) ของ employee_id นี้ → สถานะ "Revoked"
  3. ส่ง Welcome Push Notification ผ่าน LINE Messaging API
  4. บันทึก Audit Log: EVENT_LINE_BINDING_APPROVED
```

#### Security Controls & Revocation

| กฎ | รายละเอียด |
|---|---|
| 1 LINE ต่อ 1 Employee | Approve LINE ใหม่ → Revoke LINE เก่าของ Employee นั้นอัตโนมัติ |
| 1 Employee ต่อ 1 LINE | LINE ID เดิมผูกซ้ำไม่ได้ข้าม Employee |
| Admin Revoke | Admin สามารถกด Revoke ได้ทุกเวลา พร้อมระบุเหตุผล |
| Webhook Rate Limit | LINE Webhook Endpoint ถูก Rate Limit แยกต่างหาก (ดู 3.7) |

#### Welcome Push Notification Payload (ตัวอย่าง)

```json
{
  "to": "<line_user_id>",
  "messages": [
    {
      "type": "text",
      "text": "✅ การผูกบัญชีสำเร็จแล้ว!\nยินดีต้อนรับสู่ [ชื่อแอปย่อย]\nคุณสามารถเข้าใช้งานระบบได้ทันที"
    }
  ]
}
```

---

### ข้อกำหนดที่ 3.5: ระบบปรับแต่งโทนสีและภาพลักษณ์หน้าเว็บ (Dynamic Theme Engine)

#### CSS Variables Architecture

การกำหนดสีสัน UI ทั้งหมดอ้างอิงผ่าน CSS Custom Properties ร่วมกับ **Tailwind CSS v4**:

```css
:root[data-theme="corporate-navy"] {
  --color-primary: #1e3a5f;
  --color-secondary: #2d6a9f;
  --color-accent: #4a9eda;
  --color-background: #f4f6f9;
  --color-surface: #ffffff;
  --color-text-primary: #1a1a2e;
  --color-text-secondary: #6b7280;
}

:root[data-theme="industrial-amber"] {
  --color-primary: #b45309;
  --color-secondary: #d97706;
  --color-accent: #fbbf24;
  /* ... */
}
```

**ธีมที่รองรับ (Built-in Themes):**

| ธีม | สีหลัก | เหมาะกับ |
|---|---|---|
| Corporate Navy | #1e3a5f | ระบบงาน Office, การเงิน |
| Industrial Amber | #b45309 | โรงงาน, การผลิต |
| Eco Green | #166534 | สิ่งแวดล้อม, ความยั่งยืน |
| Minimalist Slate | #475569 | ทั่วไป, เรียบง่าย |

#### Theme Selection & Anti-Flicker Strategy

```
Admin เลือกธีมในหน้า Settings
        │
        ▼
บันทึกลง Database (app_settings table)
        │
        ▼
ตั้งค่า Cookie: theme=corporate-navy (Path=/, Max-Age=31536000)
        │
        ▼
Next.js Server Component อ่าน Cookie ก่อน Render
        │
        ▼
พ่น data-theme="corporate-navy" บน <html> ตั้งแต่ Server-side
        │
        ▼
ผู้ใช้เห็นธีมถูกต้องตั้งแต่ Frame แรก → ไม่มี Flicker
```

#### Dark / Light Mode

| โหมด | กลไก |
|---|---|
| System Auto | ตรวจ `prefers-color-scheme` จาก OS อัตโนมัติ |
| Manual Override | ผู้ใช้กด Toggle → เก็บใน localStorage + Cookie |
| Server Sync | Cookie ส่งค่าให้ Next.js Server Component รู้โหมดก่อน Render |

> **Single Source of Truth:** เมื่อ User เปลี่ยน Dark Mode ให้ถือ **Cookie เป็น Master** เสมอ localStorage ใช้เพื่อ read ฝั่ง Client เท่านั้น ถ้าค่าทั้งสองไม่ตรงกัน (เช่น เปิดสองแท็บสลับโหมดคนละแท็บ) ให้ใช้ค่าจาก Cookie และ sync localStorage ให้ตรงกัน

---

### ข้อกำหนดที่ 3.6: ระบบ Audit Log & Event Matrix

ทุก Event สำคัญต้องถูกบันทึกลงตาราง `audit_logs` โดยอัตโนมัติ

#### Event Matrix

| Event Type | Trigger | Actor | Target |
|---|---|---|---|
| `AUTH_LOGIN_SUCCESS` | Login สำเร็จ | Employee | - |
| `AUTH_LOGIN_FAILED` | Login ล้มเหลว | Employee (attempt) | - |
| `AUTH_ACCOUNT_LOCKED` | บัญชีถูกล็อก | System | Employee |
| `AUTH_ACCOUNT_UNLOCKED` | Admin ปลดล็อก | Admin | Employee |
| `AUTH_LOGOUT` | Logout | Employee | - |
| `AUTH_TOKEN_REFRESHED` | Auto-refresh Token | System | Employee |
| `USER_PROVISIONED` | Admin เพิ่มผู้ใช้ใหม่ | Admin | Employee |
| `USER_DEPROVISIONED` | Admin/System ยกเลิกสิทธิ์ | Admin / System | Employee |
| `USER_ROLE_CHANGED` | เปลี่ยนบทบาท | Admin | Employee |
| `ROLE_CREATED` | สร้างบทบาทใหม่ | Admin | Role |
| `ROLE_UPDATED` | แก้ไขบทบาท / สิทธิ์เมนู | Admin | Role |
| `ROLE_DELETED` | ลบบทบาท | Admin | Role |
| `LINE_BINDING_REQUESTED` | พนักงานขอผูก LINE | Employee (via LINE) | - |
| `LINE_BINDING_APPROVED` | Admin อนุมัติการผูก | Admin | Employee |
| `LINE_BINDING_REVOKED` | Revoke การผูก LINE | Admin / System | Employee |
| `THEME_CHANGED` | เปลี่ยนธีม | Admin | - |
| `SETTINGS_UPDATED` | เปลี่ยนการตั้งค่าระบบ | Admin | - |

#### Metadata ที่ต้องบันทึกเสมอ

```json
{
  "ip_address": "192.168.1.100",
  "user_agent": "Mozilla/5.0 ...",
  "request_id": "uuid-v4",
  "timestamp": "2025-01-01T10:00:00Z",
  "additional": { }
}
```

> **หมายเหตุ:** `timestamp` ต้องเป็น UTC เสมอ (ดูข้อกำหนด 3.14)

#### Audit Log Retention Policy

| ระดับความสำคัญ | ประเภท Event | Retention |
|---|---|---|
| Critical | AUTH_ACCOUNT_LOCKED, USER_DEPROVISIONED | 2 ปี |
| High | AUTH_LOGIN_*, USER_PROVISIONED, LINE_BINDING_* | 1 ปี |
| Medium | ROLE_*, SETTINGS_* | 6 เดือน |

#### 3.6.1 Audit Log Cleanup Job

Retention Policy ต้องมี Executor ที่ทำงานอัตโนมัติ ระบบใช้ **PostgreSQL `pg_cron`** (ไม่ต้องการ Dependency เพิ่ม) หรือ **Celery Beat** ถ้า Stack มีอยู่แล้ว

**ตัวเลือกที่แนะนำ: pg_cron (ไม่มี External Dependency)**

```sql
-- ติดตั้ง extension (ต้องการ Superuser)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- รันทุกวันเวลา 02:00 UTC (09:00 Bangkok)
SELECT cron.schedule(
  'audit-log-cleanup',
  '0 2 * * *',
  $$
    DELETE FROM audit_logs
    WHERE
      (event_type IN ('AUTH_ACCOUNT_LOCKED', 'USER_DEPROVISIONED')
        AND created_at < NOW() - INTERVAL '2 years')
      OR
      (event_type LIKE 'AUTH_LOGIN_%'
        OR event_type IN ('USER_PROVISIONED', 'LINE_BINDING_REQUESTED', 'LINE_BINDING_APPROVED', 'LINE_BINDING_REVOKED')
        AND created_at < NOW() - INTERVAL '1 year')
      OR
      (event_type LIKE 'ROLE_%' OR event_type LIKE 'SETTINGS_%'
        AND created_at < NOW() - INTERVAL '6 months');
  $$
);
```

**ทางเลือก: Celery Beat (ถ้า Stack มี Celery อยู่แล้ว)**

```python
# celery_config.py
from celery.schedules import crontab

beat_schedule = {
    "audit-log-cleanup": {
        "task": "tasks.cleanup_audit_logs",
        "schedule": crontab(hour=2, minute=0),  # 02:00 UTC ทุกวัน
    },
}
```

| พารามิเตอร์ | ค่า |
|---|---|
| เวลารัน | 02:00 UTC (09:00 Bangkok) ทุกวัน |
| ต้อง Log ผลลัพธ์ | จำนวน rows ที่ลบ, duration, timestamp |
| ต้อง Alert เมื่อ fail | ส่ง notification ไปยัง Monitoring System |

---

### ข้อกำหนดที่ 3.7: Rate Limiting & API Protection

ใช้ **Redis 7** เป็น Backend สำหรับ Rate Limiting ทุก Endpoint

#### Rate Limit Matrix

| Endpoint | Limit | Window | กลยุทธ์ |
|---|---|---|---|
| `POST /auth/login` | 5 req | 15 นาที / ต่อ IP | Fixed Window |
| `POST /auth/refresh` | 10 req | 1 นาที / ต่อ User | Sliding Window |
| `POST /line/webhook` | 100 req | 1 นาที / ต่อ IP | Fixed Window |
| `GET /api/v1/*` (ทั่วไป) | 300 req | 1 นาที / ต่อ User | Sliding Window |
| `POST /admin/*` | 60 req | 1 นาที / ต่อ User | Fixed Window |

> **หมายเหตุ:** Rate Limit by IP ต้องอ่าน IP จาก `X-Forwarded-For` header ที่ตั้งค่าโดย Reverse Proxy เท่านั้น ห้าม Trust โดยตรงจาก Client (ดูข้อกำหนดการติดตั้ง Nginx ใน 4.1)

#### Response เมื่อ Rate Limit เกิน

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1704067200

{
  "error": "rate_limit_exceeded",
  "message": "คำขอมากเกินไป กรุณารอ 60 วินาที"
}
```

> **หมายเหตุ Headers:** ปัจจุบันใช้ `X-RateLimit-*` ซึ่งเป็น de facto standard ที่ Client library ส่วนใหญ่รองรับ หากต้องการรองรับ RFC draft (`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) ให้ส่งทั้งสองรูปแบบพร้อมกันเพื่อ backward compatibility:
>
> ```http
> X-RateLimit-Limit: 5
> X-RateLimit-Remaining: 0
> X-RateLimit-Reset: 1704067200
> RateLimit-Limit: 5
> RateLimit-Remaining: 0
> RateLimit-Reset: 1704067200
> RateLimit-Policy: 5;w=900
> ```

---

### ข้อกำหนดที่ 3.8: CSRF Protection

แม้ `SameSite=Lax` จะป้องกัน CSRF ได้บางส่วน แต่ระบบต้องใช้ **Double Submit Cookie Pattern** เพิ่มเติมเพื่อป้องกัน Edge Case เช่น Subdomain Attack

#### Double Submit Cookie Pattern

```
1. FastAPI สร้าง CSRF Token (Random 32 bytes) ตอน Login
2. ส่ง CSRF Token ผ่าน:
   - Cookie: csrf_token=<token>; SameSite=Strict; Secure
   - Response Body: { "csrf_token": "<token>" }
3. Frontend เก็บ Token ใน Memory (ไม่เก็บใน localStorage)
4. ทุก State-Changing Request (POST, PUT, PATCH, DELETE):
   - แนบ Header: X-CSRF-Token: <token>
5. FastAPI Middleware ตรวจสอบ: Cookie == Header → ผ่าน
```

> **หมายเหตุเรื่อง Token Recovery:** เนื่องจาก CSRF Token ถูกเก็บใน Memory เมื่อ Browser Tab ถูก Refresh หรือปิดแล้วเปิดใหม่ Token จะหายไป ระบบต้องมี `GET /api/v1/auth/csrf-token` ที่ผู้ใช้ที่ Login แล้ว (มี Cookie ถูกต้อง) สามารถเรียกเพื่อดึง CSRF Token ใหม่ได้โดยไม่ต้อง Login ซ้ำ Frontend ควรเรียก Endpoint นี้อัตโนมัติเมื่อตรวจพบว่าไม่มี Token ใน Memory

#### ข้อควรระวัง: CSRF กับ LINE WebView (iOS/Android)

LINE WebView โดยเฉพาะบน iOS มีพฤติกรรม Cookie ที่ไม่สม่ำเสมอ โดยเฉพาะกับ `SameSite` attribute:

| สถานการณ์ | พฤติกรรมที่อาจพบ |
|---|---|
| LINE WebView บน iOS | `SameSite=Lax` อาจถูก block ใน cross-origin context |
| LINE LIFF (ใน Browser) | ทำงานปกติ |
| LINE In-App Browser เก่า | อาจไม่รองรับ `SameSite=Strict` |

**แนวทางแก้ไข:**
- **ต้องทดสอบบน LINE WebView จริง** ก่อน Production เสมอ ทั้งบน iOS และ Android
- ถ้าพบปัญหา ให้รองรับ `SameSite=None; Secure` สำหรับ Flow ที่เปิดผ่าน LINE (ตรวจจาก User-Agent)
- บันทึก fallback policy ไว้ใน `.env` เช่น `LIFF_SAMESITE_NONE=true`

#### Endpoints ที่ต้องการ CSRF Validation

| Method | ต้องการ CSRF |
|---|---|
| GET, HEAD, OPTIONS | ❌ ไม่ต้อง |
| POST, PUT, PATCH, DELETE | ✅ ต้องทุก Endpoint |

---

### ข้อกำหนดที่ 3.9: WebSocket Specification

#### Use Cases ที่ระบบรองรับ

| Feature | กลไก | คำอธิบาย |
|---|---|---|
| Real-time Notifications | WebSocket | แจ้งเตือนเหตุการณ์ภายในแอป เช่น มีคำขอ LINE Binding ใหม่ |
| Dashboard Live Data | WebSocket หรือ SSE | อัปเดตข้อมูลบน Dashboard แบบ Real-time |
| Session Expiry Warning | WebSocket | แจ้งเตือนผู้ใช้ก่อน Token หมดอายุ 2 นาที |

#### WebSocket Authentication

```
WS Handshake Request:
GET /ws/connect
Cookie: access_token=<jwt>    ← ตรวจสอบด้วย Cookie เดิม

FastAPI ตรวจสอบ JWT ก่อนยอมรับ Connection
ถ้า Token หมดอายุ → ปิด Connection พร้อม Code 4001 (Unauthorized)
```

> **ข้อควรระวัง Safari / LINE WebView:** Browser บางตัว (Safari, LINE WebView) อาจจำกัดการส่ง Cookie ใน WebSocket Handshake ใน cross-site context ถ้าพบปัญหา ให้ใช้ Short-lived One-Time Token แทนดังนี้:
>
> 1. Frontend เรียก `GET /api/v1/auth/ws-token` → ได้ token อายุ 30 วินาที, ใช้ได้ครั้งเดียว
> 2. เชื่อม WebSocket ด้วย `GET /ws/connect?token=<ws_token>`
> 3. FastAPI ตรวจสอบ token จาก Redis และลบทิ้งทันทีหลัง Validate
>
> **⚠️ ห้ามใช้ Long-lived JWT ใน URL** เพราะติด Server Log และ Browser History

#### WebSocket Message Format

```json
{
  "event": "notification",
  "type": "line_binding_requested",
  "payload": {
    "line_display_name": "สมชาย ใจดี",
    "requested_at": "2025-01-01T10:00:00Z"
  }
}
```

#### Reconnection Strategy

Frontend ต้องรองรับการ Reconnect อัตโนมัติเมื่อ Connection หลุด:

| พารามิเตอร์ | ค่า | คำอธิบาย |
|---|---|---|
| Initial Delay | 1 วินาที | รอก่อน Reconnect ครั้งแรก |
| Backoff Multiplier | 2x | แต่ละครั้งรอนานขึ้น 2 เท่า |
| Max Delay | 30 วินาที | จำกัด Delay สูงสุด |
| Max Retries | 10 ครั้ง | หยุดพยายามหลังจากนี้ แสดง UI แจ้ง User |

```typescript
// ตัวอย่าง Reconnection Logic
let retryCount = 0;
const MAX_RETRIES = 10;
const BASE_DELAY = 1000;

function connectWebSocket() {
  const ws = new WebSocket("/ws/connect");

  ws.onclose = (event) => {
    if (event.code === 4001) {
      // Unauthorized → redirect to login
      window.location.href = "/login";
      return;
    }
    if (retryCount < MAX_RETRIES) {
      const delay = Math.min(BASE_DELAY * Math.pow(2, retryCount), 30000);
      retryCount++;
      setTimeout(connectWebSocket, delay);
    } else {
      // แสดง UI แจ้งผู้ใช้ว่า Realtime disconnected
    }
  };

  ws.onopen = () => { retryCount = 0; };
}
```

#### Session Expiry Warning — Fallback Policy

กรณีที่ WebSocket ไม่ได้เปิดอยู่ (User ไม่ได้อยู่หน้า Dashboard หรือ Connection หลุด) ระบบต้องมี Fallback:

```
ถ้ามี WebSocket → รับ event "session_expiry_warning" (2 นาทีก่อนหมดอายุ)
ถ้าไม่มี WebSocket → Frontend ตรวจ JWT expiry ใน Cookie จาก Server Component
    │
    ├─ เหลือ < 3 นาที → ทำ Silent Refresh อัตโนมัติ (POST /auth/refresh)
    └─ หมดอายุแล้ว → Redirect /login
```

> **หมายเหตุ:** Access Token TTL = 15 นาที ให้ Frontend decode expiry จาก JWT payload แล้วตั้ง `setTimeout` สำหรับ silent refresh เมื่อเหลือ 3 นาที เพื่อ cover กรณีที่ WebSocket ไม่พร้อม

---

### ข้อกำหนดที่ 3.10: Webhook Signature Verification

LINE Messaging API กำหนดให้ทุก Webhook Request ต้องผ่านการตรวจสอบ **HMAC-SHA256 Signature** ก่อนประมวลผลเสมอ การข้ามขั้นตอนนี้ทำให้ Endpoint รับ Request จากแหล่งอื่นได้ ซึ่งอาจถูกใช้ปลอม LINE Binding หรือ inject Event ปลอมเข้าระบบ

#### กลไกการตรวจสอบ

LINE ส่ง Header `X-Line-Signature` พร้อมทุก Webhook Request โดย Signature คำนวณจาก:

```
HMAC-SHA256(body_bytes, channel_secret) → Base64 encode
```

#### Verification Flow

```
POST /line/webhook
        │
        ▼
อ่าน Raw Request Body (bytes)
        │
        ▼
คำนวณ HMAC-SHA256(body, LINE_CHANNEL_SECRET)
        │
        ▼
Base64 encode ผล → expected_signature
        │
        ├─ expected_signature == X-Line-Signature → ✅ ประมวลผลต่อ
        └─ ไม่ตรง → ❌ ตอบกลับ HTTP 400 Bad Request ทันที
```

#### ตัวอย่าง Implementation (FastAPI)

```python
import hashlib
import hmac
import base64
from fastapi import Request, HTTPException

LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")

async def verify_line_signature(request: Request) -> bytes:
    body = await request.body()
    signature = request.headers.get("X-Line-Signature", "")

    hash_value = hmac.new(
        LINE_CHANNEL_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    expected = base64.b64encode(hash_value).decode("utf-8")

    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid signature")

    return body

@router.post("/line/webhook")
async def line_webhook(body: bytes = Depends(verify_line_signature)):
    events = json.loads(body)
    # ประมวลผล events ต่อ ...
```

> **หมายเหตุ:** `hmac.new(key, msg, digestmod)` คือ signature ที่ถูกต้องใน Python standard library พร้อม positional argument ครบ 3 ตัวเสมอ

#### ข้อกำหนดเพิ่มเติม

| ข้อกำหนด | รายละเอียด |
|---|---|
| ใช้ `hmac.compare_digest()` เสมอ | ป้องกัน Timing Attack (ห้ามใช้ `==` เปรียบเทียบ String ตรงๆ) |
| อ่าน Raw Body ก่อน Parse JSON | Body ที่ถูก Parse แล้วอาจ reorder key → Signature ไม่ตรง |
| `LINE_CHANNEL_SECRET` ต้องอยู่ใน Environment Variable | ห้าม Hardcode ในโค้ด |
| Log เฉพาะ Event Type | ห้าม Log Raw Body ที่มีข้อมูล LINE User ใน Production |

#### Idempotency Key — ป้องกัน Duplicate Webhook Event

LINE Messaging API มี Retry Mechanism ที่อาจส่ง Webhook Request ซ้ำได้ในกรณี Network Error ทำให้เกิด Duplicate Event เช่น `LINE_BINDING_REQUESTED` ซ้ำสองครั้งใน Audit Log หรือ Trigger Business Logic ซ้ำ

**กลไก:**

LINE ส่ง Header `X-Line-Delivery` พร้อมทุก Webhook Request ซึ่งเป็น Unique ID ต่อ Delivery ให้ใช้ค่านี้เป็น Idempotency Key

```
POST /line/webhook
X-Line-Delivery: <unique-delivery-id>
        │
        ▼
ตรวจสอบ Redis: EXISTS idempotency:line:<delivery-id>
        │
        ├─ พบ Key → Event นี้ถูก Process แล้ว → ตอบ 200 OK ทันที (ไม่ Process ซ้ำ)
        └─ ไม่พบ Key → Process Event → SET idempotency:line:<delivery-id> TTL 24h
```

```python
async def process_line_webhook(request: Request, body: bytes = Depends(verify_line_signature)):
    delivery_id = request.headers.get("X-Line-Delivery", "")

    if delivery_id:
        idempotency_key = f"idempotency:line:{delivery_id}"
        if await redis.exists(idempotency_key):
            # Already processed — return 200 silently
            return {"status": "already_processed"}
        await redis.setex(idempotency_key, 86400, "1")  # TTL 24 ชั่วโมง

    events = json.loads(body)
    # ประมวลผล events ...
```

| พารามิเตอร์ | ค่า | หมายเหตุ |
|---|---|---|
| Key Format | `idempotency:line:<delivery-id>` | ใน Redis |
| TTL | 24 ชั่วโมง | LINE retry window ไม่เกิน 24h |
| Fallback | ถ้าไม่มี `X-Line-Delivery` Header | ใช้ `event.source.userId + event.timestamp` เป็น Key แทน |

---

### ข้อกำหนดที่ 3.11: Error Handling & API Response Standard

ทุก Endpoint ต้องส่ง Response ในรูปแบบ **มาตรฐานเดียวกัน** เพื่อให้ Frontend จัดการ Error ได้สม่ำเสมอและ audit log สามารถ parse ได้อัตโนมัติ

#### Response Schema มาตรฐาน

**กรณีสำเร็จ:**
```json
{
  "success": true,
  "data": { },
  "meta": {
    "request_id": "uuid-v4",
    "timestamp": "2025-01-01T10:00:00Z"
  }
}
```

**กรณี Error:**
```json
{
  "success": false,
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "ไม่พบผู้ใช้งานในระบบ",
    "detail": "employee_id EMP999 does not exist"
  },
  "meta": {
    "request_id": "uuid-v4",
    "timestamp": "2025-01-01T10:00:00Z"
  }
}
```

#### Error Code Registry (ระดับ Application)

| HTTP Status | Error Code | ความหมาย |
|---|---|---|
| 400 | `VALIDATION_ERROR` | ข้อมูล Input ไม่ถูกต้อง |
| 400 | `INVALID_SIGNATURE` | Webhook Signature ไม่ตรง |
| 401 | `UNAUTHORIZED` | ไม่ได้ Login หรือ Token หมดอายุ |
| 401 | `TOKEN_EXPIRED` | Access Token หมดอายุ (แยกจาก Unauthorized) |
| 403 | `FORBIDDEN` | Login แล้วแต่ไม่มีสิทธิ์ |
| 404 | `NOT_FOUND` | ไม่พบ Resource ที่ร้องขอ |
| 409 | `CONFLICT` | ข้อมูลซ้ำ เช่น Employee ถูก Provision แล้ว |
| 422 | `UNPROCESSABLE` | ข้อมูลถูกต้องแต่ทำไม่ได้ เช่น Revoke บัญชีตัวเอง |
| 429 | `RATE_LIMIT_EXCEEDED` | Request มากเกินกำหนด |
| 500 | `INTERNAL_ERROR` | ข้อผิดพลาดภายในระบบ |
| 503 | `SERVICE_UNAVAILABLE` | Core-API หรือ Redis ไม่ตอบสนอง |

#### Global Exception Handler (FastAPI)

```python
from fastapi import Request
from fastapi.responses import JSONResponse
import uuid
from datetime import datetime, timezone

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # ไม่ expose Stack Trace ใน Production
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง"
            },
            "meta": {
                "request_id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        }
    )
```

> **หมายเหตุ:** ใน Development mode (`ENVIRONMENT=development`) สามารถเพิ่ม `"detail"` ที่มี stack trace ได้ แต่ต้อง **ปิดใน Production** เสมอ

#### Pagination Response (สำหรับ List Endpoints)

```json
{
  "success": true,
  "data": [ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "total_pages": 8
  },
  "meta": {
    "request_id": "uuid-v4",
    "timestamp": "2025-01-01T10:00:00Z"
  }
}
```

**Query Parameters มาตรฐาน:**

| Parameter | Default | คำอธิบาย |
|---|---|---|
| `page` | 1 | หน้าที่ต้องการ |
| `limit` | 20 | จำนวนรายการต่อหน้า (max: 100) |
| `sort` | `created_at` | ฟิลด์ที่ต้องการเรียง |
| `order` | `desc` | ทิศทาง: `asc` หรือ `desc` |

---

### ข้อกำหนดที่ 3.12: Input Validation & Sanitization

#### หลักการทั่วไป

- ทุก Input ต้องผ่าน **Pydantic Schema Validation** ก่อนเข้า Business Logic เสมอ
- FastAPI + Pydantic v2 จัดการ Type Coercion และ Validation อัตโนมัติ
- ห้ามใช้ Raw dict หรือ `request.json()` โดยตรงใน Endpoint ที่รับข้อมูลจาก User

#### Pydantic Schema มาตรฐาน

```python
from pydantic import BaseModel, Field, field_validator
import re

class ProvisionUserRequest(BaseModel):
    employee_id: str = Field(
        min_length=3,
        max_length=20,
        pattern=r"^[A-Z0-9]+$",   # ตัวพิมพ์ใหญ่ + ตัวเลขเท่านั้น
        description="รหัสพนักงาน"
    )
    role_id: UUID

    @field_validator("employee_id")
    @classmethod
    def sanitize_employee_id(cls, v: str) -> str:
        return v.strip().upper()


class UpdateRoleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    description: str = Field(default="", max_length=255)

    @field_validator("name", "description")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()
```

#### ข้อกำหนดเฉพาะ Field

| Field ประเภท | ข้อกำหนด |
|---|---|
| `employee_id` | ตัวพิมพ์ใหญ่ + ตัวเลข, 3–20 ตัวอักษร, ไม่มี special chars |
| `email` | ตรวจ format ด้วย `EmailStr` ของ Pydantic |
| Text fields (ชื่อ, คำอธิบาย) | `max_length` ระบุเสมอ, strip whitespace |
| Free-text (เหตุผล, หมายเหตุ) | `max_length=500`, strip HTML tags |
| UUID fields | ใช้ `UUID` type ของ Python โดยตรง |
| Integer (page, limit) | ระบุ `ge=1` และ `le=100` สำหรับ pagination |

#### HTML / Script Injection Prevention

FastAPI + Pydantic ไม่ได้ auto-escape HTML โดยค่าเริ่มต้น ฟิลด์ที่อาจถูก Render เป็น HTML (เช่น ชื่อ, หมายเหตุ) ต้องผ่าน sanitizer:

```python
import html

def sanitize_text(value: str) -> str:
    """Escape HTML special characters"""
    return html.escape(value.strip())
```

#### SQL Injection Prevention

- ใช้ **SQLAlchemy ORM** หรือ **Parameterized Query** ทุกกรณี
- ห้ามใช้ String Concatenation ใน Query เด็ดขาด

```python
# ❌ ห้ามทำ
query = f"SELECT * FROM users WHERE employee_id = '{employee_id}'"

# ✅ ถูกต้อง (SQLAlchemy ORM)
user = db.query(LocalUser).filter(LocalUser.employee_id == employee_id).first()

# ✅ ถูกต้อง (Parameterized)
result = db.execute(text("SELECT * FROM users WHERE employee_id = :eid"), {"eid": employee_id})
```

---

### ข้อกำหนดที่ 3.13: Redis Fault Tolerance

Redis เป็น **Single Point of Failure** สำหรับฟีเจอร์หลักหลายอย่าง ได้แก่ Session, Rate Limiting, Brute-force Lockout, และ Token Blocklist ระบบต้องมีนโยบายรองรับเมื่อ Redis หยุดทำงาน เพื่อไม่ให้ผู้ใช้ทุกคนถูก Logout พร้อมกัน

#### Degradation Policy ต่อ Feature

| Feature | เมื่อ Redis ล่ม | นโยบาย |
|---|---|---|
| Session Validation | ไม่สามารถตรวจ Revocation ได้ | **Allow-through** — ให้ JWT ที่ยังไม่หมดอายุผ่านได้ (ยอมรับความเสี่ยงชั่วคราว) |
| Rate Limiting | ไม่สามารถนับ Request ได้ | **Allow-through** — ยอมให้ Request ผ่านชั่วคราว บันทึก Warning log |
| Brute-force Lockout | ไม่สามารถตรวจ Lockout ได้ | **Deny-all Login** — ปิดการ Login ทั้งหมดจนกว่า Redis จะกลับมา (ป้องกัน Brute-force ระหว่าง outage) |
| Token Blocklist | Force-logout ทำงานไม่ได้ | **Allow-through** — Log เตือน, แจ้ง Admin ผ่าน Monitoring |

#### Implementation Pattern

```python
from redis.exceptions import RedisError
import logging

logger = logging.getLogger(__name__)

async def check_rate_limit(redis: Redis, key: str, limit: int, window: int) -> bool:
    try:
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, window)
        return count <= limit
    except RedisError as e:
        logger.warning(f"Redis unavailable for rate limiting: {e}")
        return True  # Allow-through policy

async def is_account_locked(redis: Redis, employee_id: str) -> bool:
    try:
        return await redis.exists(f"lockout:{employee_id}") > 0
    except RedisError as e:
        logger.error(f"Redis unavailable for lockout check: {e}")
        return True  # Deny-all policy: ปิด Login เมื่อ Redis ล่ม
```

#### Redis High Availability (Production)

สำหรับ Production ที่ต้องการ Uptime สูง ให้พิจารณา:

| ตัวเลือก | ความซับซ้อน | เหมาะกับ |
|---|---|---|
| **Redis Sentinel** | ปานกลาง | Self-hosted, ต้องการ Auto-failover |
| **Redis Cluster** | สูง | Traffic สูงมาก, ต้องการ Horizontal Scale |
| **Managed Redis** (ElastiCache, Upstash) | ต่ำ | Cloud environment, ลด Ops overhead |

**ขั้นต่ำที่แนะนำ:** Redis Sentinel พร้อม 1 Master + 2 Replica สำหรับ Production

#### Health Check & Alerting

- `GET /health/redis` ต้องรายงาน status ของ Redis ทุก 30 วินาที
- เมื่อ Redis ล่มนานกว่า 2 นาที ต้องส่ง Alert ไปยัง Monitoring System (PagerDuty, LINE Notify, หรือ Email)
- บันทึก Redis Error ทุกครั้งใน Application Log พร้อม timestamp

---

### ข้อกำหนดที่ 3.14: Time Zone Standard

ระบบมีหลายชั้น (PostgreSQL, Redis, FastAPI, Next.js, LINE API) และทำงานในบริบท **Asia/Bangkok (UTC+7)** แต่ถ้าแต่ละ layer เก็บหรือแสดง timezone ต่างกัน จะทำให้ Audit Log อ่านยาก, Report คลาดเคลื่อน, และ Retention Policy ทำงานผิดพลาด

#### หลักการกลาง

| หลักการ | รายละเอียด |
|---|---|
| **เก็บทุกอย่างเป็น UTC** | Database, Redis, Audit Log, API Response ทุก timestamp เป็น UTC |
| **แสดงผลเป็น Asia/Bangkok** | แปลงเป็น UTC+7 เฉพาะที่ Frontend หรือ Report เท่านั้น |
| **ส่ง ISO 8601 พร้อม Offset** | Format: `2025-01-01T17:00:00+07:00` หรือ `2025-01-01T10:00:00Z` |

#### PostgreSQL Configuration

```sql
-- ตั้งค่า Server Timezone เป็น UTC
ALTER SYSTEM SET timezone = 'UTC';
SELECT pg_reload_conf();

-- ตรวจสอบ
SHOW timezone;  -- ต้องได้ UTC

-- ใช้ TIMESTAMPTZ เสมอ (ไม่ใช้ TIMESTAMP without timezone)
CREATE TABLE audit_logs (
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### SQLAlchemy Configuration

```python
from sqlalchemy import DateTime
from sqlalchemy.orm import mapped_column
from datetime import datetime, timezone

class AuditLog(Base):
    # ✅ ถูกต้อง: timezone=True บอก SQLAlchemy ให้ใช้ TIMESTAMPTZ
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc)
    )
```

#### FastAPI: สร้าง Timestamp อย่างถูกต้อง

```python
from datetime import datetime, timezone

# ✅ ถูกต้อง — timezone-aware UTC
now_utc = datetime.now(timezone.utc)

# ❌ ผิด — naive datetime ไม่มี timezone info
now_wrong = datetime.now()
now_wrong2 = datetime.utcnow()  # deprecated ใน Python 3.12+
```

#### Next.js: แปลงและแสดงผล

```typescript
// ✅ แปลง UTC → Asia/Bangkok สำหรับแสดงผลเท่านั้น
function formatBangkokTime(utcString: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(utcString));
}

// ✅ ส่ง timestamp กลับ API เป็น ISO 8601 UTC
const payload = {
  created_at: new Date().toISOString(),  // "2025-01-01T10:00:00.000Z"
};
```

#### Redis: TTL และ Expiry

Redis ใช้ Unix Timestamp (UTC) สำหรับ TTL โดยค่าเริ่มต้น ไม่จำเป็นต้องปรับ timezone แต่เมื่อ Log เวลาจาก Redis ต้อง format เป็น UTC ก่อน:

```python
import time

# ✅ บันทึก expiry time เป็น UTC Unix timestamp
expiry_unix = int(time.time()) + 900  # 15 นาที
await redis.setex(key, 900, value)
```

#### สรุป Timezone Checklist

| Layer | ต้องทำ |
|---|---|
| PostgreSQL | ใช้ `TIMESTAMPTZ`, Server timezone = UTC |
| SQLAlchemy Models | `DateTime(timezone=True)` ทุกฟิลด์ที่เป็น timestamp |
| FastAPI | ใช้ `datetime.now(timezone.utc)` เสมอ |
| API Response | ส่ง ISO 8601 + `Z` suffix หรือ `+00:00` |
| Next.js Display | แปลงเป็น `Asia/Bangkok` ด้วย `Intl.DateTimeFormat` |
| Audit Log | เก็บและแสดง UTC, ระบุ timezone ใน UI |

---

### ข้อกำหนดที่ 3.15: ระบบการตั้งชื่อและการกำหนดค่าแอปพลิเคชัน (App Identity & Settings)

เมื่อ Template ถูก Clone ไปใช้งานหลายแอปในองค์กร แต่ละแอปต้องมีชื่อและ Config เป็นของตัวเอง ระบบนี้ออกแบบให้ **ตั้งค่าได้ง่ายตอน Clone ผ่าน `.env`** และ **Admin เปลี่ยนได้ภายหลังผ่าน UI** โดยไม่ต้อง Redeploy

#### กลยุทธ์: ENV as Default + DB Override

```
อ่านค่าจาก DB (app_settings.app_name)
        │
        ├─ มีค่า (ไม่ใช่ NULL) → ✅ ใช้ค่าจาก DB
        └─ NULL หรือยังไม่มี Row → Fallback ใช้ ENV["APP_NAME"]
```

แนวคิดนี้ทำให้:
- **Clone ใหม่:** ตั้ง `APP_NAME` ใน `.env` แล้วรัน Seed → ขึ้นได้ทันที ไม่ต้องเข้า UI
- **เปลี่ยนชื่อภายหลัง:** Admin แก้ผ่านหน้า System Settings → บันทึกลง DB → มีผลทันทีโดยไม่ต้อง Redeploy

#### โครงสร้างตาราง `app_settings` (Single Row)

ตาราง `app_settings` มี **1 Row ตลอดอายุของแอป** สร้างโดย Seed Script และมีเพียงหนึ่ง Record เสมอ:

```python
# models/app_settings.py
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import DateTime
from datetime import datetime, timezone

class AppSettings(Base):
    __tablename__ = "app_settings"

    id:               Mapped[UUID]     = mapped_column(primary_key=True, default=uuid4)
    app_name:         Mapped[str]      = mapped_column(VARCHAR(100))
    app_logo_url:     Mapped[str|None] = mapped_column(VARCHAR(500), nullable=True)
    theme:            Mapped[str]      = mapped_column(VARCHAR(50), default="minimalist-slate")
    dark_mode:        Mapped[str]      = mapped_column(VARCHAR(10), default="system")
    timezone_display: Mapped[str]      = mapped_column(VARCHAR(50), default="Asia/Bangkok")
    updated_by:       Mapped[str|None] = mapped_column(VARCHAR(50), nullable=True)
    updated_at:       Mapped[datetime] = mapped_column(
                          DateTime(timezone=True),
                          default=lambda: datetime.now(timezone.utc),
                          onupdate=lambda: datetime.now(timezone.utc)
                      )
```

#### Config ที่ Admin เปลี่ยนได้ผ่าน UI

| Field | ค่าตั้งต้นจาก ENV | ตัวเลือก / ข้อจำกัด |
|---|---|---|
| `app_name` | `APP_NAME` | VARCHAR(100), ต้องไม่ว่าง |
| `app_logo_url` | - | URL หรือ NULL (ใช้ Default Logo) |
| `theme` | `DEFAULT_THEME` | `corporate-navy`, `industrial-amber`, `eco-green`, `minimalist-slate` |
| `dark_mode` | `DEFAULT_DARK_MODE` | `system`, `light`, `dark` |
| `timezone_display` | `Asia/Bangkok` | IANA Timezone string เช่น `Asia/Bangkok`, `UTC` |

#### FastAPI: Service Layer

```python
# services/app_settings.py
import os
from sqlalchemy.orm import Session
from models import AppSettings

def get_app_settings(db: Session) -> dict:
    """อ่าน settings จาก DB หรือ fallback ไป ENV"""
    row = db.query(AppSettings).first()

    return {
        "app_name":         row.app_name        if row else os.getenv("APP_NAME", "My App"),
        "app_logo_url":     row.app_logo_url     if row else None,
        "theme":            row.theme            if row else os.getenv("DEFAULT_THEME", "minimalist-slate"),
        "dark_mode":        row.dark_mode        if row else os.getenv("DEFAULT_DARK_MODE", "system"),
        "timezone_display": row.timezone_display if row else "Asia/Bangkok",
    }

def update_app_settings(db: Session, data: UpdateAppSettingsRequest, actor_id: str) -> AppSettings:
    """อัปเดต settings และบันทึก Audit Log"""
    row = db.query(AppSettings).first()
    if not row:
        raise ValueError("App settings not initialized. Run seed script first.")

    row.app_name         = data.app_name
    row.app_logo_url     = data.app_logo_url
    row.theme            = data.theme
    row.dark_mode        = data.dark_mode
    row.timezone_display = data.timezone_display
    row.updated_by       = actor_id

    db.commit()
    db.refresh(row)

    # Audit Log
    log_event(db, event_type="SETTINGS_UPDATED", actor_employee_id=actor_id)

    return row
```

#### API Endpoints

| Method | Path | สิทธิ์ | คำอธิบาย |
|---|---|---|---|
| `GET` | `/api/v1/settings/app` | Public (ไม่ต้อง Login) | ดึง app_name, theme, logo สำหรับ Render หน้า Login |
| `GET` | `/api/v1/settings/app` | Any User | ดึง settings ครบทุก field |
| `PUT` | `/api/v1/settings/app` | Super Admin เท่านั้น | อัปเดต settings |

> **หมายเหตุ:** Endpoint `GET /api/v1/settings/app` ต้องเปิด Public บางส่วนเพื่อให้หน้า Login แสดงชื่อแอปและโลโก้ได้ก่อนที่ User จะ Login แต่ต้อง **จำกัดข้อมูลที่ส่งกลับ** เฉพาะ `app_name`, `app_logo_url`, `theme` เท่านั้น

#### Next.js: การโหลด App Settings

App Settings ต้องโหลดจาก Server Component เพื่อไม่ให้เกิด Layout Shift และส่งให้ Client ผ่าน Context:

```typescript
// app/layout.tsx — Server Component
import { getAppSettings } from "@/lib/api/settings";

export async function generateMetadata() {
  const settings = await getAppSettings();
  return {
    title: settings.app_name,
  };
}

export default async function RootLayout({ children }) {
  const settings = await getAppSettings();

  return (
    <html data-theme={settings.theme}>
      <body>
        <AppSettingsProvider settings={settings}>
          {children}
        </AppSettingsProvider>
      </body>
    </html>
  );
}
```

```typescript
// lib/api/settings.ts
export async function getAppSettings() {
  // ดึงจาก FastAPI — ทำงานบน Server เท่านั้น
  const res = await fetch(`${process.env.API_URL}/api/v1/settings/app`, {
    next: { revalidate: 60 }, // Cache 60 วินาที, revalidate อัตโนมัติ
  });
  return res.json();
}
```

#### Caching Strategy

App Settings เปลี่ยนไม่บ่อย แต่ต้องมีผลทันทีเมื่อ Admin แก้ไข:

| Layer | กลไก | TTL |
|---|---|---|
| Next.js Fetch Cache | `next: { revalidate: 60 }` | 60 วินาที |
| Redis Cache (Optional) | `app:settings` key | 60 วินาที, Invalidate ทันทีเมื่อ PUT |
| Browser | ผ่าน React Context, ไม่ Cache ใน localStorage | Session |

**Cache Invalidation เมื่อ Admin อัปเดต:**

```python
# หลัง update_app_settings สำเร็จ
await redis.delete("app:settings")  # ล้าง Redis cache ทันที

# Next.js: เรียก revalidatePath หรือ revalidateTag
# (ทำผ่าน Next.js revalidation API ถ้าต้องการ instant update)
```

#### .env Variables ที่เกี่ยวข้อง

```env
# App Identity (ใช้เป็น Default ก่อน Seed / ถ้า DB ยังไม่มีค่า)
APP_NAME=ชื่อแอปของคุณ
DEFAULT_THEME=minimalist-slate
DEFAULT_DARK_MODE=system
```

---

### ข้อกำหนดที่ 3.16: LINE Push Notification Mode

ระบบต้องรองรับการเปิด/ปิด และการเลือกโหมดการส่ง LINE Push Notification เพื่อป้องกันไม่ให้ LINE Messaging API ที่ล่มหรือ Latency สูงส่งผลกระทบต่อ UX ของ Admin

#### Environment Configuration

```env
# LINE_PUSH_MODE: sync | async | disabled
LINE_PUSH_MODE=sync
```

| Mode | พฤติกรรม | เหมาะกับ |
|---|---|---|
| `sync` | ส่ง Push Notification ทันทีในขั้นตอนเดียวกับ Request | Default, ระบบที่ต้องการ Delivery ทันที |
| `async` | Queue ไว้ใน Redis แล้ว Worker ส่งในเบื้องหลัง | ระบบที่ต้องการ Response เร็ว, ทนต่อ LINE API ล่ม |
| `disabled` | ไม่ส่ง Push Notification เลย (Log เตือนไว้) | Development, ช่วงที่ LINE API มีปัญหา |

#### Sync Mode Flow

```
Admin กด Approve LINE Binding
        │
        ▼
ส่ง Welcome Message ผ่าน LINE API ทันที
        │
        ├─ สำเร็จ → บันทึก Audit Log + Response 200
        └─ ล้มเหลว → Log Warning + Response 200 (ไม่ Block กระบวนการ Approve)
```

> **หมายเหตุ:** ใน `sync` mode LINE API failure ต้องไม่ทำให้ Approve flow ล้มเหลว ให้ try/except ครอบ push call และ log error ไว้เท่านั้น

#### Async Mode Flow

```
Admin กด Approve LINE Binding
        │
        ▼
บันทึกลง DB + เขียน Job ลง Redis Queue
        │
        ▼
Response 200 ทันที (ไม่รอ LINE API)
        │
        ▼
Worker อ่าน Queue → ส่ง Push Notification → Retry ถ้า fail (max 3 ครั้ง)
```

```python
# ตัวอย่าง Queue Job ใน Redis
async def queue_line_push(redis: Redis, to: str, message: str):
    job = {
        "to": to,
        "message": message,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "retry_count": 0
    }
    await redis.rpush("line:push:queue", json.dumps(job))
```

#### Disabled Mode

```python
# services/line_push.py
async def send_welcome_message(line_user_id: str, app_name: str):
    mode = os.getenv("LINE_PUSH_MODE", "sync")

    if mode == "disabled":
        logger.warning(f"LINE Push disabled. Skipped message to {line_user_id}")
        return

    if mode == "async":
        await queue_line_push(redis, line_user_id, f"ยินดีต้อนรับสู่ {app_name}")
        return

    # sync mode
    try:
        await call_line_messaging_api(line_user_id, app_name)
    except Exception as e:
        logger.error(f"LINE Push failed (sync): {e}")
        # ไม่ raise — ไม่ให้ block Approve flow
```

---

## 4. ข้อกำหนดการติดตั้งและการพัฒนา (Deployment & DevOps Specifications)

### 4.1 Docker Containerization

**Docker Compose (Local Development):**

```yaml
# docker-compose.yml (สรุปโครงสร้าง)
services:
  frontend:   # Next.js 15 (Port 3000)
  backend:    # FastAPI (Port 8000)
  postgres:   # PostgreSQL 16 (Port 5432)
  redis:      # Redis 7 (Port 6379)
```

**Production Build:**

| Service | Strategy | เหตุผล |
|---|---|---|
| Next.js | `output: 'standalone'` | ลดขนาด Image, ไม่ต้องการ node_modules ทั้งหมด |
| FastAPI | Multi-stage Dockerfile | แยก Build Layer และ Runtime Layer |
| PostgreSQL | Official Image + Volume Mount | ข้อมูลถาวร |
| Redis | Official Image + AOF Persistence | ป้องกันข้อมูล Session หาย |

**Multi-stage Dockerfile (FastAPI ตัวอย่าง):**

```dockerfile
# Stage 1: Build
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stage 2: Runtime
FROM python:3.12-slim AS runtime
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY . .
USER nobody
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Nginx Reverse Proxy (Production):**

Nginx ต้องตั้งค่า `X-Forwarded-For` อย่างถูกต้องเพื่อให้ Rate Limit by IP ทำงานได้:

```nginx
server {
    listen 443 ssl;

    location /api/ {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://frontend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

FastAPI ต้องตั้งค่า `trusted_hosts` เพื่อ Trust `X-Forwarded-For` จาก Nginx เท่านั้น:

```python
from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

app = FastAPI()
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["yourdomain.com"])

# Trust proxy header จาก Nginx
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="nginx")
```

### 4.2 Local Mock Mode

```env
# .env.local
MOCK_CORE_API=true          # เปิดใช้ Mock Mode
MOCK_EMPLOYEE_ID=EMP001     # รหัสพนักงานทดสอบ
MOCK_EMPLOYEE_NAME=Test User
```

**Guard: ป้องกัน Mock Mode ใน Production:**

```python
# main.py
import os
if os.getenv("ENVIRONMENT") == "production" and os.getenv("MOCK_CORE_API") == "true":
    raise RuntimeError("MOCK_CORE_API must not be enabled in production environment!")
```

**Build-time Guard (Dockerfile):**

```dockerfile
# Stage 2: Runtime — ตรวจสอบ MOCK flag ก่อน build Production Image
ARG MOCK_CORE_API
ARG ENVIRONMENT
RUN if [ "$MOCK_CORE_API" = "true" ] && [ "$ENVIRONMENT" = "production" ]; then \
      echo "ERROR: Cannot build production image with MOCK_CORE_API=true" && exit 1; \
    fi
```

> **เหตุผล:** Runtime check ป้องกันการ Start แต่ไม่ป้องกันการ Build Image ที่ผิดพลาด Build-time guard ป้องกันตั้งแต่ขั้นตอน CI/CD ก่อนที่ Image จะถูก Push เข้า Registry

**CI/CD Block (GitHub Actions ตัวอย่าง):**

```yaml
- name: Check Mock Mode Not Enabled
  run: |
    if grep -q "MOCK_CORE_API=true" .env.production; then
      echo "ERROR: MOCK_CORE_API=true found in production config!"
      exit 1
    fi
```

### 4.3 Health Check Endpoints

ระบบแยก Health Check เป็น 2 ระดับตามมาตรฐาน Kubernetes:

| ระดับ | Endpoint | คำอธิบาย | ใช้ใน |
|---|---|---|---|
| **Liveness** | `GET /health/live` | ตรวจว่า Process ยังรันอยู่ (ไม่ตรวจ Dependencies) | Kubernetes `livenessProbe` |
| **Readiness** | `GET /health/ready` | ตรวจว่าพร้อม Serve Traffic (ตรวจ DB + Redis) | Kubernetes `readinessProbe`, Load Balancer |
| DB Check | `GET /health/db` | การเชื่อมต่อ PostgreSQL | Monitoring |
| Redis Check | `GET /health/redis` | การเชื่อมต่อ Redis | Monitoring |
| Core-API Check | `GET /health/core-api` | การเชื่อมต่อ Core-API | Monitoring |

**Response Format:**

```json
// GET /health/ready
{
  "status": "healthy",        // "healthy" | "degraded" | "unhealthy"
  "checks": {
    "database": "ok",
    "redis": "ok",
    "core_api": "ok"
  },
  "timestamp": "2025-01-01T10:00:00Z"
}
```

> **หมายเหตุ:** Load Balancer ควร route traffic ไปยัง `/health/ready` เท่านั้น ถ้า Redis ล่มแต่ DB ยังทำงานได้ ให้ return `"status": "degraded"` (HTTP 200) เพื่อไม่ให้ Pod ถูก Remove ออกจาก Pool โดยไม่จำเป็น แต่ถ้า DB ล่มให้ return HTTP 503

---

### 4.4 Environment Variables ใน Next.js Standalone Build

Next.js Standalone Build มีพฤติกรรมเกี่ยวกับ Environment Variables ที่แตกต่างจาก Standard Build อย่างมีนัยสำคัญ และเป็น **กับดักที่พบบ่อยมาก** เมื่อ Deploy หลาย Environment

#### ความแตกต่างที่ต้องเข้าใจ

| ประเภท Variable | Build Behavior | Runtime Behavior |
|---|---|---|
| `NEXT_PUBLIC_*` | **Bake เข้า Bundle ตอน Build** | ❌ เปลี่ยนไม่ได้หลัง Build |
| Server-side (ไม่มี Prefix) | ไม่ถูก Bundle | ✅ อ่านจาก Environment ตอน Runtime |

ผลลัพธ์: ถ้า Build Image เดียวแล้วใช้กับทั้ง `staging` และ `production` **ค่า `NEXT_PUBLIC_*` ทุกตัวจะเป็นค่าของ staging** ใน production ด้วย

#### กฎการแบ่งประเภท Variable

```
NEXT_PUBLIC_APP_NAME=...         ✅ ค่าเดียวกันทุก environment (เช่น ชื่อแอป)
NEXT_PUBLIC_API_URL=...          ❌ ห้ามใช้สำหรับ URL ที่เปลี่ยนตาม environment
NEXT_PUBLIC_LINE_LIFF_ID=...     ❌ ห้ามใช้ถ้า LIFF ID ต่างกันใน staging/prod

API_URL=...                      ✅ ใช้ Server-side เพื่อเรียก Backend API
LINE_LIFF_ID=...                 ✅ ใช้ Server-side แล้วส่งผ่าน getServerSideProps
```

#### Pattern ที่แนะนำ: Runtime Config via Server Component

แทนที่จะใช้ `NEXT_PUBLIC_*` สำหรับค่าที่เปลี่ยนตาม environment ให้ส่งผ่าน Server Component:

```typescript
// app/layout.tsx — Server Component
export default function RootLayout({ children }) {
  // อ่านจาก Server-side ENV (runtime, ไม่ถูก bake)
  const config = {
    apiUrl: process.env.API_URL,
    liffId: process.env.LINE_LIFF_ID,
    appName: process.env.APP_NAME,
  };

  return (
    <html>
      <body>
        <ConfigProvider config={config}>
          {children}
        </ConfigProvider>
      </body>
    </html>
  );
}
```

```typescript
// components/ConfigProvider.tsx — Client Component
"use client";
import { createContext, useContext } from "react";

const ConfigContext = createContext(null);

export function ConfigProvider({ config, children }) {
  return (
    <ConfigContext.Provider value={config}>
      {children}
    </ConfigContext.Provider>
  );
}

export const useConfig = () => useContext(ConfigContext);
```

#### สรุป: ตัวแปรที่ต้องเป็น Server-side เสมอ

| Variable | เหตุผล |
|---|---|
| `API_URL` | URL ต่างกันระหว่าง dev/staging/prod |
| `LINE_CHANNEL_SECRET` | Secret ห้าม expose ฝั่ง Client |
| `LINE_LIFF_ID` | อาจต่างกันตาม environment |
| `CORE_API_URL` | Internal URL ที่ต่างกันตาม environment |
| `X_API_KEY` | Secret ห้าม expose ฝั่ง Client เด็ดขาด |

#### .env.example Template

```env
# === SERVER-SIDE ONLY (ไม่ขึ้นต้น NEXT_PUBLIC_) ===
API_URL=http://localhost:8000
CORE_API_URL=https://core-api.internal
LINE_CHANNEL_SECRET=your_channel_secret_here
LINE_LIFF_ID=your_liff_id_here

# === BUILD-TIME (ค่าเดียวกันทุก environment) ===
NEXT_PUBLIC_APP_NAME=FutureSign Dashboard

# === RUNTIME FLAGS ===
ENVIRONMENT=development
NODE_ENV=production
```

---

## 5. Seed Script & Migration Strategy

### 5.1 Migration Strategy (Alembic)

```bash
# สร้าง Migration ใหม่
alembic revision --autogenerate -m "init_base_tables"

# รัน Migration
alembic upgrade head

# Rollback 1 Version
alembic downgrade -1
```

**Migration Workflow:**

```
โคลนโปรเจกต์
    │
    ▼
cp .env.example .env  →  แก้ไขค่า Config
    │
    ▼
docker compose up -d postgres redis
    │
    ▼
alembic upgrade head   →  สร้างตารางทั้งหมด
    │
    ▼
python seed.py         →  ใส่ข้อมูลเริ่มต้น
    │
    ▼
พร้อมใช้งาน ✅
```

---

### 5.2 Alembic Migration Branching Strategy

เมื่อทีมมีนักพัฒนาหลายคนทำงานบน Feature Branch พร้อมกัน มีความเสี่ยงที่ Migration History จะ **แตกสาย (Branch)** ทำให้ `alembic upgrade head` ล้มเหลวใน Staging หรือ Production

#### ปัญหา: Migration Branch Conflict

```
main:         A → B → C
feature/user:         ↘ D   (สร้างจาก C)
feature/role:         ↘ E   (สร้างจาก C พร้อมกัน)

ผลลัพธ์เมื่อ Merge ทั้งคู่:
              A → B → C → D
                        ↘ E
```

รัน `alembic upgrade head` จะได้ Error: `Multiple heads detected` และไม่สามารถ deploy ได้

#### วิธีตรวจสอบ

```bash
# ตรวจว่ามี Branch หรือไม่
alembic heads

# ถ้าได้ผลลัพธ์มากกว่า 1 บรรทัด = มี Branch
# abc123 (head)
# def456 (head)   ← มี 2 heads = ปัญหา
```

#### วิธีแก้: Merge Migration

```bash
# Merge 2 heads เข้าด้วยกัน
alembic merge -m "merge_user_and_role_branches" abc123 def456

# ได้ Migration file ใหม่ที่มี down_revision เป็น tuple
# down_revision = ('abc123', 'def456')

# ตรวจสอบว่า head เดียวแล้ว
alembic heads   # ต้องได้ 1 บรรทัด

# Upgrade
alembic upgrade head
```

#### Branching Policy สำหรับทีม

| กฎ | รายละเอียด |
|---|---|
| **1 Migration ต่อ 1 PR** | แต่ละ Feature Branch สร้าง Migration ได้ แต่ต้อง Merge ให้เป็น Single Head ก่อน merge เข้า main |
| **ตรวจ `alembic heads` ใน CI/CD** | Pipeline ต้อง fail ถ้าพบ Multiple Heads ใน branch ก่อน Deploy |
| **ห้ามแก้ Migration ที่ Deploy แล้ว** | ถ้าต้องเปลี่ยน Schema ให้สร้าง Migration ใหม่เสมอ |
| **ทดสอบ Downgrade** | ทุก Migration ต้องมี `downgrade()` function ที่ rollback ได้สมบูรณ์ |

#### CI/CD Gate ตัวอย่าง

```yaml
# .github/workflows/deploy.yml
- name: Check Single Migration Head
  run: |
    HEAD_COUNT=$(alembic heads | wc -l)
    if [ "$HEAD_COUNT" -gt "1" ]; then
      echo "ERROR: Multiple migration heads detected. Merge branches first."
      alembic heads
      exit 1
    fi
```

#### Migration File Template

```python
"""
{description}

Revision ID: {rev_id}
Revises: {parent_rev}
Create Date: {create_date} (UTC)
"""
from alembic import op
import sqlalchemy as sa

revision = "{rev_id}"
down_revision = "{parent_rev}"  # หรือ tuple ถ้าเป็น merge
branch_labels = None
depends_on = None

def upgrade() -> None:
    # TODO: implement upgrade
    pass

def downgrade() -> None:
    # TODO: implement downgrade (ต้อง reverse upgrade ได้สมบูรณ์)
    pass
```

---

### 5.3 Seed Script

Seed Script จะสร้างข้อมูลพื้นฐานที่จำเป็นสำหรับแอปย่อยใหม่:

**ข้อมูลที่ Seed:**

| ข้อมูล | รายการ |
|---|---|
| System Roles | `Super Admin`, `Admin`, `Supervisor`, `Operator` |
| Default Menus | Dashboard, Report, User Management, LINE OA Settings, System Settings |
| Permission Matrix | Super Admin → สิทธิ์ทุกเมนู, บทบาทอื่น → ไม่มีสิทธิ์ (Admin ตั้งเอง) |
| App Settings | `app_name` จาก `APP_NAME` env, Theme = `DEFAULT_THEME`, Dark Mode = `DEFAULT_DARK_MODE`, Logo = NULL |
| First Admin User | ดึงจาก `SEED_ADMIN_EMPLOYEE_ID` ใน `.env` |

**ตัวอย่างรัน Seed:**

```bash
# ตั้งค่า ENV ก่อน
APP_NAME="ระบบ HR Dashboard" SEED_ADMIN_EMPLOYEE_ID=EMP001 python seed.py

# ผลลัพธ์
✅ Created 4 system roles
✅ Created 5 default menus
✅ Created permission matrix
✅ Provisioned admin user: EMP001
✅ Created default app settings (app_name: "ระบบ HR Dashboard")
🎉 Seed completed successfully!
```

#### App Settings Single-Row Guard

ตาราง `app_settings` ต้องมี 1 Row ตลอดเวลา ระบบต้องมี Guard 2 ชั้น:

**ชั้นที่ 1 — PostgreSQL Trigger (ป้องกัน DELETE Row สุดท้าย):**

```sql
CREATE OR REPLACE FUNCTION prevent_empty_app_settings()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM app_settings) = 0 THEN
    RAISE EXCEPTION 'Cannot delete the last app_settings row. Use UPDATE instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_empty_app_settings
  BEFORE DELETE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION prevent_empty_app_settings();
```

**ชั้นที่ 2 — Application-level Fallback (ป้องกัน Row หายโดย Seed ไม่ถูกรัน):**

ฟังก์ชัน `get_app_settings()` ใน Service Layer ใช้ ENV เป็น Fallback อยู่แล้ว (ดูข้อกำหนด 3.15) ทำให้แอปไม่ Crash แม้ตารางว่าง แต่ต้อง Log Warning เตือน:

```python
def get_app_settings(db: Session) -> dict:
    row = db.query(AppSettings).first()
    if not row:
        logger.warning("app_settings table is empty! Using ENV defaults. Run seed.py to fix.")
    return {
        "app_name": row.app_name if row else os.getenv("APP_NAME", "My App"),
        # ...
    }
```

---

## 6. Backup & Recovery Policy

### 6.1 Database Backup

| พารามิเตอร์ | ค่า |
|---|---|
| เครื่องมือ | `pg_dump` (ขั้นต่ำ) หรือ `wal-g` สำหรับ Production ที่ต้องการ Point-in-Time Recovery |
| ความถี่ | อย่างน้อยวันละ 1 ครั้ง (แนะนำ 02:00 UTC) |
| Retention | 7 วัน (Rolling) |
| ที่เก็บ | Object Storage ภายนอก (S3, GCS, หรือ NAS) ห้ามเก็บบน Host เดียวกับ DB |
| การตรวจสอบ | ทดสอบ Restore อย่างน้อยเดือนละ 1 ครั้ง |

**ตัวอย่าง Backup Script (pg_dump):**

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_${DATE}.sql.gz"

pg_dump \
  -h $DB_HOST \
  -U $DB_USER \
  -d $DB_NAME \
  --no-password \
  | gzip > /backups/$BACKUP_FILE

# ลบ backup เก่ากว่า 7 วัน
find /backups -name "backup_*.sql.gz" -mtime +7 -delete

echo "✅ Backup completed: $BACKUP_FILE"
```

### 6.2 ข้อมูลที่ต้อง Backup เป็นพิเศษ

| ตาราง | เหตุผล |
|---|---|
| `app_settings` | Config ที่ Admin ตั้งเอง ถ้าหายต้องตั้งใหม่ทั้งหมด |
| `local_roles` + `role_menu_permissions` | Permission Matrix ที่ใช้เวลาตั้งค่านาน |
| `local_users` | รายชื่อผู้ใช้และ Role Assignment |
| `line_bindings` | การผูก LINE ที่ต้องให้ User ทำใหม่ถ้าหาย |

---

## 7. Security Checklist สรุป

| หัวข้อ | กลไก | สถานะ |
|---|---|---|
| XSS Prevention | HttpOnly Cookie (ไม่ให้ JS เข้าถึง Token) | ✅ Required |
| CSRF Prevention | Double Submit Cookie Pattern | ✅ Required |
| CSRF Token Recovery | `GET /api/v1/auth/csrf-token` เมื่อ Token หาย | ✅ Required |
| CSRF + WebView | ทดสอบบน LINE WebView iOS/Android, รองรับ `SameSite=None` fallback | ✅ Required |
| Brute-force Protection | Redis Rate Limit + Account Lockout | ✅ Required |
| API Rate Limiting | Redis per Endpoint per User/IP | ✅ Required |
| RFC Rate Limit Headers | รองรับทั้ง `X-RateLimit-*` และ `RateLimit-*` (RFC draft) | 🔶 Recommended |
| SQL Injection | SQLAlchemy ORM + Parameterized Query | ✅ Required |
| Input Validation | Pydantic Schema + HTML Sanitization | ✅ Required |
| Secure Transport | HTTPS Only, `Secure` Cookie Flag | ✅ Required |
| Reverse Proxy Config | Nginx `X-Forwarded-For` + TrustedHost | ✅ Required |
| Session Revocation | Refresh Token ใน Redis (ลบได้ทันที) | ✅ Required |
| Redis Fault Tolerance | Degradation Policy per Feature | ✅ Required |
| RBAC Enforcement | Two-Way Guard (Frontend + Backend) | ✅ Required |
| Audit Trail | Audit Log ทุก Critical Event (UTC) | ✅ Required |
| Audit Log Cleanup | Automated Job (pg_cron หรือ Celery Beat) | ✅ Required |
| Webhook Signature | HMAC-SHA256 + `hmac.compare_digest()` | ✅ Required |
| Webhook Idempotency | `X-Line-Delivery` Key ใน Redis (TTL 24h) | ✅ Required |
| Time Zone Standard | UTC Storage, Bangkok Display | ✅ Required |
| Mock Mode Guard | Build-time (Dockerfile) + Runtime check + CI/CD gate | ✅ Required |
| LINE Binding Security | 1:1 Constraint + Admin Approval | ✅ Required |
| LINE Push Mode | `sync\|async\|disabled` via ENV | ✅ Required |
| Next.js Env Vars | Server-side for Runtime Config | ✅ Required |
| Migration Safety | Single Head Gate ใน CI/CD | ✅ Required |
| Error Handling | Global Exception Handler + Standard Schema | ✅ Required |
| Dependency Security | Dependency scanning ใน CI/CD | 🔶 Recommended |
| Secret Management | Environment Variables (ไม่ Hardcode) | ✅ Required |
| Docker Security | Non-root user ใน Container | ✅ Required |
| WebSocket Auth | Cookie-based + One-time Token fallback สำหรับ Safari/WebView | ✅ Required |
| WebSocket Reconnect | Exponential Backoff, Max 10 retries | ✅ Required |
| Health Check | Liveness + Readiness แยกกัน | ✅ Required |
| DB Backup | `pg_dump` daily, Retention 7 วัน, ทดสอบ Restore รายเดือน | ✅ Required |
| app_settings Guard | DB Trigger + Application Fallback | ✅ Required |
| menu is_active Flag | ปิดเมนูชั่วคราวได้โดยไม่ลบ DB | ✅ Required |

---

## Changelog

| เวอร์ชัน | วันที่ | รายการเปลี่ยนแปลง |
|---|---|---|
| v1.0 | 2025 | Initial Release |
| v1.1 | 2025 | เพิ่ม Rate Limiting Matrix, WebSocket Spec, Brute-force Protection |
| v1.2 | 2025 | เพิ่ม Webhook Signature Verification (3.10), Error Handling Standard (3.11), Input Validation (3.12), Redis Fault Tolerance (3.13), Time Zone Standard (3.14), Next.js Standalone ENV Guide (4.4), Alembic Branching Strategy (5.2), ปรับ Security Checklist |
| v1.3 | 2025 | เพิ่ม App Identity & Settings (3.15), ตาราง `app_settings` ใน Schema, ENV as Default + DB Override pattern, Caching Strategy, ปรับ Seed Script |
| v1.4 | 2025 | เพิ่ม LINE Push Notification Mode (3.16), Webhook Idempotency Key (3.10), WebSocket Reconnection Strategy + Session Expiry Fallback + Safari Token Fallback (3.9), CSRF Token Recovery + WebView note (3.8), Dark Mode Single Source of Truth (3.5), RFC Rate Limit Headers note (3.7), Audit Log Cleanup Job (3.6.1), `local_menus.is_active` flag, `role_menu_permissions` UNIQUE constraint, `line_bindings` Index hint, app_settings Single-Row Guard + DB Trigger (5.3), Backup & Recovery Policy (6), Liveness vs Readiness Health Check (4.3), MOCK_CORE_API Build-time Dockerfile Guard (4.2), แก้ไข `hmac.new()` signature note (3.10), ปรับ Security Checklist |

---

*จบข้อกำหนดคุณสมบัติทางเทคนิค — System Specification v1.4*
*FutureSign Platform Team*
