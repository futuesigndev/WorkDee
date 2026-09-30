## 6. ภาคผนวก: พจนานุกรมข้อมูลและข้อกำหนดทางเทคนิค

### 6.1 พจนานุกรมข้อมูล (Data Dictionary)

#### 6.1.1 Location Master

| ฟิลด์ | ประเภท | คำอธิบาย |
|---|---|---|
| `location_id` | String | รหัสสถานที่ (PK) |
| `name` | String | ชื่อสถานที่ |
| `latitude` | Decimal | ละติจูด |
| `longitude` | Decimal | ลองจิจูด |
| `radius_meters` | Integer | รัศมีปลอดภัย (เมตร) |
| `address` | Text | ที่อยู่ |
| `created_at` | Timestamp | วันที่สร้าง |
| `updated_at` | Timestamp | วันที่แก้ไข |

#### 6.1.2 Attendance Policy Template

| ฟิลด์ | ประเภท | คำอธิบาย |
|---|---|---|
| `policy_id` | String | รหัสนโยบาย (PK) |
| `name` | String | ชื่อนโยบาย |
| `check_in_time` | Time | เวลาเข้างาน |
| `check_out_time` | Time | เวลาเลิกงาน |
| `grace_period_minutes` | Integer | เวลาผ่อนผัน (นาที) |

#### 6.1.3 Employee Work Profile

| ฟิลด์ | ประเภท | คำอธิบาย |
|---|---|---|
| `employee_id` | String | รหัสพนักงาน (PK) |
| `line_user_id` | String | LINE User ID |
| `primary_location_id` | String | สถานที่หลัก (FK) |
| `policy_id` | String | นโยบายเวลาที่ใช้ (FK) |
| `wfh_mode` | Boolean | เปิด/ปิดโหมด WFH |
| `home_location_id` | String | รหัสพิกัดบ้าน (FK) |
| `consent_status` | String | สถานะความยินยอม |

#### 6.1.4 Attendance Log

| ฟิลด์ | ประเภท | คำอธิบาย |
|---|---|---|
| `log_id` | String | รหัสบันทึก (PK) |
| `employee_id` | String | รหัสพนักงาน (FK) |
| `timestamp` | Timestamp | เวลาที่กด (จากเซิร์ฟเวอร์) |
| `log_type` | Enum | `check_in` / `check_out` |
| `latitude` | Decimal | ละติจูดจริง |
| `longitude` | Decimal | ลองจิจูดจริง |
| `accuracy_meters` | Decimal | ความแม่นยำ GPS |
| `distance_meters` | Decimal | ระยะห่างจากเป้าหมาย |
| `time_status` | Enum | `on_time` / `late` / `early_leave` |
| `location_status` | Enum | `inside` / `outside` / `auto_approved` |
| `flag_status` | Enum | `none` / `yellow` / `red` |
| `reason` | Text | เหตุผล |
| `photo_url` | String | URL ของภาพ |
| `device_info` | JSON | ข้อมูลอุปกรณ์ |
| `created_at` | Timestamp | วันที่สร้าง |

---

### 6.2 ข้อกำหนดทางเทคนิค

#### 6.2.1 LINE LIFF

- ใช้ LIFF SDK เวอร์ชันล่าสุด
- รองรับ LINE เวอร์ชัน 11.0 ขึ้นไป
- มี Fallback Web View สำหรับ LINE เวอร์ชันเก่า

#### 6.2.2 Geolocation API

- ใช้ `navigator.geolocation.getCurrentPosition()`
- ตั้ง `enableHighAccuracy: true`
- Timeout: 10 วินาที
- Maximum Age: 0 (ไม่ใช้ cache)

#### 6.2.3 Camera API

- ใช้ `getUserMedia()` สำหรับเปิดกล้องสด
- บังคับ `facingMode: "environment"` (กล้องหลัง)
- ตรวจสอบ Permission ก่อนใช้งาน

#### 6.2.4 Security

- ใช้ HTTPS ทั้งหมด
- เข้ารหัสข้อมูลอ่อนไหว (AES-256)
- ใช้ JWT สำหรับ Authentication
- Rate Limiting สำหรับ API

#### 6.2.5 Storage

- ภาพถ่าย: เก็บใน Cloud Storage (เช่น S3, GCS) พร้อม Signed URL
- Database: PostgreSQL หรือ MySQL
- Cache: Redis สำหรับ Session

---

## 📌 สรุปเอกสาร

เอกสารฉบับนี้เป็น **Master Specification** สำหรับระบบ **WorkDee (เวิร์กดี)** ที่รวม:

- ✅ ภาพรวมสถาปัตยกรรมและปรัชญาการออกแบบ
- ✅ Roadmap 3 ระยะ
- ✅ รายละเอียด Phase 0 แบบครบถ้วน (รวม Risk Mitigations, PDPA, Edge Cases)
- ✅ แนวทาง Phase 1 และ Phase 2
- ✅ พจนานุกรมข้อมูลและข้อกำหนดทางเทคนิค

**พร้อมสำหรับส่งต่อ:**
- ทีมออกแบบ (Designer) → ใช้ Screen Requirements + UI/UX Philosophy
- ทีมพัฒนา (Developer) → ใช้ Data Dictionary + Technical Specs
- ทีม HR (Product Owner) → ใช้ Risk Mitigations + PDPA Flow

---

**เวอร์ชัน:** 1.0 (Master Spec)
**วันที่:** [ระบุวันที่]
**ผู้จัดทำ:** [ระบุชื่อ]
**สถานะ:** ✅ ฉบับสมบูรณ์