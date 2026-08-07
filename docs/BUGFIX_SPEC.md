# Bug Fix Specification — FutureSign Corporate Template

> เอกสารนี้อธิบาย **บัคที่พบและวิธีแก้ไข** สำหรับโปรเจคที่ clone จาก template นี้ไปแล้ว  
> ควรตรวจสอบและ apply ทั้ง 2 เรื่องก่อน deploy ระบบ

---

## BUG-001 · First-Login Admin Bootstrap Logic ผิด

### 📋 อาการ

ผู้ใช้ **ทุกคน** ที่ไม่เคย login มาก่อน จะได้รับ **Admin role โดยอัตโนมัติ**  
ไม่ว่าจะมีผู้ใช้คนอื่นในระบบอยู่แล้วหรือไม่ก็ตาม

### 🔍 Root Cause

**ไฟล์:** `backend/app/auth_router.py` — `POST /api/v1/auth/login`

โค้ดเดิมตั้งใจให้แค่ "คนแรก" ได้ Admin แต่ logic ผิด:

```python
# โค้ดเดิม (ผิด)
if not user:
    # หา Admin role — แต่ seeds.py สร้างไว้แล้วตั้งแต่ startup
    role_stmt = select(LocalRole).where(LocalRole.name == "Admin")
    default_role = role_result.scalar_one_or_none()
    # ↑ เจอ Admin role ทุกครั้ง → ทุกคนที่ login ครั้งแรกได้ Admin!
    user = LocalUser(..., role_id=default_role.id)
```

`seeds.py` สร้าง `Admin` role ไว้ตั้งแต่ startup แล้ว ทำให้ condition `if not default_role` ไม่มีทางเป็น `True` อีกต่อไป และทุก new user ได้รับ Admin role เสมอ

### ✅ วิธีแก้ไข

**Design ที่ถูกต้อง:**

| สถานการณ์ | พฤติกรรม |
|-----------|-----------|
| ยังไม่มี user ในระบบเลย | คนแรก Login → ได้ Admin (bootstrap) |
| มี user แล้ว + employee นี้ถูก provision แล้ว | Login ได้ปกติ |
| มี user แล้ว + employee นี้ **ไม่ได้ provision** | **403** — Access denied |

**แก้ไข `backend/app/auth_router.py`:**

```python
# แก้ไข section: if not user: (ใน login endpoint)

if not user:
    # ตรวจว่ามี user คนอื่นในระบบแล้วหรือยัง
    user_count_stmt = select(LocalUser)
    user_count_result = await db.execute(user_count_stmt)
    existing_users = user_count_result.scalars().all()

    if existing_users:
        # มี user แล้ว → ต้องถูก provision ก่อนเท่านั้น
        raise HTTPException(
            status_code=403,
            detail="Access denied. Your account has not been provisioned. Please contact an administrator."
        )

    # ยังไม่มี user เลย → bootstrap: คนแรก = Admin
    role_stmt = select(LocalRole).where(LocalRole.name == "Admin")
    role_result = await db.execute(role_stmt)
    default_role = role_result.scalar_one_or_none()

    if not default_role:
        default_role = LocalRole(name="Admin", is_system_role=True)
        db.add(default_role)
        await db.flush()

    user = LocalUser(
        employee_id=core_data["user"]["employee_id"],
        full_name=core_data["user"]["full_name"],
        department=core_data["user"].get("department", "N/A"),
        division=core_data["user"].get("division", "N/A"),
        company=core_data["user"].get("company", "N/A"),
        role_id=default_role.id,
        is_active=True
    )
    db.add(user)
    await db.flush()
```

**แก้ exception handler** ใน login function เดียวกัน ให้ re-raise `HTTPException` แทนที่จะแปลงทุกอย่างเป็น 401:

```python
# เดิม (ผิด) — HTTPException 403 จะถูกแปลงเป็น 401
except Exception as e:
    raise HTTPException(status_code=401, detail=str(e))

# แก้ใหม่
except HTTPException:
    raise  # ← re-raise ตามเดิม ไม่แปลง status code
except Exception as e:
    raise HTTPException(status_code=401, detail=str(e))
```

### ⚠️ ข้อควรระวัง

- หากฐานข้อมูลมี user อยู่แล้วก่อนที่จะ apply fix นี้ ให้ตรวจสอบ role ของ user ทุกคนใน `local_users` ว่าถูกต้องหรือไม่
- Admin คนแรกสามารถไป provision user คนอื่นได้ที่ **Admin Dashboard → Users → Provision User**

---

## BUG-002 · Token หมดอายุ — UI กระพริบ / กดไม่ได้ / ไม่เด้งไปหน้า Login

### 📋 อาการ

เมื่อ session token หมดอายุขณะใช้งาน:
- UI **กระพริบ** ไปมา
- ปุ่มและ element ทั้งหมด **กดไม่ได้** (UI freeze)
- **ไม่ redirect** ไปหน้า login — ค้างอยู่ใน dashboard

### 🔍 Root Cause

**ไฟล์:** `frontend/src/lib/api.ts` — function `apiFetch`

```typescript
// โค้ดเดิม (ผิด)
if (res.status === 401) {
    redirectToLogin();
    return new Promise(() => {}); // ← never resolves!
}
```

`new Promise(() => {})` ไม่ resolve ตลอดไป ทำให้:

1. **UI freeze** — `async` function ของ component ที่ `await apiFetch(...)` ค้างตลอดชีพ
2. **`finally` ไม่ทำงาน** — `setLoading(false)` ไม่ถูกเรียก → spinner ค้าง → กดไม่ได้
3. **กระพริบ** — หน้า dashboard มี API call หลายตัวพร้อมกัน (logs, summary, sessions ฯลฯ) พอ token หมด ทุกตัวได้ 401 พร้อมกัน → multiple `setState` → React re-render ซ้ำหลายรอบ

### ✅ วิธีแก้ไข

**แก้ไข `frontend/src/lib/api.ts`** ทั้งไฟล์:

```typescript
const isBrowser = typeof window !== 'undefined';
export const API_URL = isBrowser ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8011");

// Custom error class — ใช้ throw แทน never-resolving promise
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

function showRedirectOverlay() {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('__session-expired-overlay__');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = '__session-expired-overlay__';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(0,0,0,0.6)', 'backdrop-filter:blur(4px)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'flex-direction:column', 'gap:12px',
  ].join(';');
  overlay.innerHTML = `
    <div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite"></div>
    <p style="color:#fff;font-size:14px;font-weight:700;letter-spacing:0.05em">Session expired — redirecting...</p>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(overlay);
}

let _isRedirectingToLogin = false;

function redirectToLogin() {
  if (_isRedirectingToLogin) return;
  _isRedirectingToLogin = true;
  showRedirectOverlay(); // บล็อก UI ทันที ก่อน navigate
  window.location.replace('/login?expired=1');
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'include' });

  if (res.status === 401) {
    redirectToLogin();
    throw new SessionExpiredError(); // ← exit async function ทันที
  }

  return res;
}
```

**แก้ไข `frontend/src/app/dashboard/layout.tsx`** — import และกรอง `SessionExpiredError`:

```typescript
// เพิ่ม SessionExpiredError ใน import
import { API_URL, apiFetch, SessionExpiredError } from '@/lib/api'

// แก้ catch ใน fetchMenus
} catch (err) {
  if (!(err instanceof SessionExpiredError)) {
    console.error('Failed to load menus', err);
  }
}

// แก้ catch ใน checkSession (heartbeat)
} catch (err) {
  if (err instanceof SessionExpiredError) return; // redirect กำลังทำงาน
  // network error — ignore (อาจแค่ offline ชั่วคราว)
}
```

**แก้ catch blocks ในทุก dashboard page** ที่ใช้ `apiFetch` เพื่อป้องกัน console spam:

```typescript
// Pattern ที่ต้องใช้ใน catch ทุกที่
} catch (err) {
  if (err instanceof SessionExpiredError) return;
  console.error('...', err);
} finally {
  setLoading(false); // finally ทำงานได้ปกติแล้วเพราะ throw แทน hang
}
```

### 💡 ทำไม throw ดีกว่า never-resolving promise

| | `return new Promise(() => {})` | `throw new SessionExpiredError()` |
|--|--|--|
| **finally block** | ❌ ไม่ทำงาน | ✅ ทำงานปกติ |
| **setLoading(false)** | ❌ ไม่ถูกเรียก → freeze | ✅ ถูกเรียก → UI clean |
| **Memory** | ❌ Leak (promise ค้างใน memory) | ✅ GC ได้ปกติ |
| **UX** | ❌ กระพริบ / กดไม่ได้ | ✅ Overlay สวยงาม พร้อม spinner |

---

## 📁 ไฟล์ที่ต้องแก้ไข (สรุป)

| ไฟล์ | BUG | การเปลี่ยนแปลง |
|------|-----|----------------|
| `backend/app/auth_router.py` | BUG-001 | แก้ bootstrap logic + fix exception handler |
| `frontend/src/lib/api.ts` | BUG-002 | แทน never-resolving promise ด้วย `SessionExpiredError` |
| `frontend/src/app/dashboard/layout.tsx` | BUG-002 | import + กรอง `SessionExpiredError` ใน catch |
| `frontend/src/app/dashboard/*/page.tsx` | BUG-002 | กรอง `SessionExpiredError` ใน catch ทุก page |

---

*FutureSign Corporate Template — Bug Fix Spec v1.0 · 2026-08-07*
