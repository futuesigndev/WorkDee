# คู่มือการติดตั้งและตั้งค่า LINE OA & LIFF Integration

เอกสารนี้อธิบายขั้นตอนการกำหนดค่าระบบเชื่อมต่อ LINE Official Account (OA) และ LINE Front-end Framework (LIFF) สำหรับระบบ **FutureSign** เพื่อให้ระบบสามารถรับข้อความจาก Webhook, ส่งการแจ้งเตือน Push Message, และให้พนักงานสามารถผูกบัญชี LINE ผ่าน LIFF App ได้อย่างสมบูรณ์

---

## 1. ภาพรวมสถาปัตยกรรม (Architecture Overview)

ระบบ FutureSign รองรับการตั้งค่า LINE Credentials แบบไดนามิกผ่าน **Admin Dashboard Settings** ซึ่งข้อมูลจะถูกบันทึกในฐานข้อมูล (`app_settings`) และมีระบบ Fallback ไปดึงจากไฟล์ `.env` หากไม่ได้กรอกข้อมูลในฐานข้อมูล

### ข้อมูลสำคัญที่ต้องใช้:
1. **LINE Channel Access Token**: ใช้สำหรับอนุญาตสิทธิ์ให้ระบบส่งข้อความหาผู้ใช้ (Push/Reply)
2. **LINE Channel Secret**: ใช้ตรวจสอบความถูกต้อง (Verify Signature) ของข้อมูลที่ส่งมาจาก LINE Webhook
3. **LINE LIFF ID**: ใช้สำหรับเปิดหน้าเว็บบน LINE App เพื่อให้พนักงานผูกบัญชีของตัวเอง

---

## 2. ขั้นตอนการตั้งค่าใน LINE Developers Console

### 2.1 สร้าง Provider และ Channel
1. เข้าไปที่ [LINE Developers Console](https://developers.line.biz/) และล็อกอินด้วยบัญชี LINE Business
2. คลิก **Create a new Provider** (หากยังไม่มี) และตั้งชื่อผู้ให้บริการ (เช่น ชื่อบริษัทของคุณ)
3. ภายใต้ Provider ที่สร้าง ให้สร้าง Channel สองประเภทดังนี้:
   * **Messaging API Channel** (สำหรับ LINE OA บอทตอบโต้อัตโนมัติและการส่งแจ้งเตือน)
   * **LINE Login Channel** (สำหรับทำ LIFF App เพื่อให้พนักงานผูกบัญชี)

---

### 2.2 การตั้งค่า Messaging API (LINE OA Settings)
1. ไปที่ Channel **Messaging API** ที่สร้างไว้
2. เลื่อนลงมาที่หัวข้อ **Channel settings** และคัดลอก **Channel secret** ไว้ (นี่คือ `LINE_CHANNEL_SECRET`)
3. ไปที่แท็บ **Messaging API settings**:
   * เลื่อนลงมาด้านล่างสุดในหัวข้อ **Channel access token** คลิก **Issue** เพื่อสร้าง Token และคัดลอกค่าไว้ (นี่คือ `LINE_CHANNEL_ACCESS_TOKEN`)
   * ในหัวข้อ **Webhook settings**:
     * ใส่ **Webhook URL**: ระบุลิงก์ Backend Webhook ของคุณ ตัวอย่างเช่น:
       `https://<your-subdomain>.ngrok-free.app/api/v1/line/webhook`
     * กด **Verify** เพื่อทดสอบการเชื่อมต่อ (ระบบต้องตอบกลับสถานะ HTTP 200 OK)
     * เปิดใช้งาน **Use webhook** (Toggle switch)
   * ในหัวข้อ **Using LINE Official Account features**:
     * ปิด **Auto-response messages** ใน LINE Official Account Manager (เพื่อไม่ให้บอทพื้นฐานของ LINE ตอบข้อความซ้ำซ้อนกับระบบเรา)
     * ปิด **Greeting messages** (หากต้องการใช้ระบบต้อนรับและส่ง Flex Message ของเราเอง)

---

### 2.3 การตั้งค่า LINE Login & LIFF Application
1. ไปที่ Channel **LINE Login** ที่สร้างไว้
2. ไปที่แท็บ **LIFF** แล้วคลิก **Add LIFF**
3. กรอกข้อมูลรายละเอียดของ LIFF App:
   * **LIFF app name**: ตั้งชื่อแอป (เช่น "FutureSign Register")
   * **Size**: เลือก **Full** เพื่อให้หน้าจอแสดงผลได้เต็มขนาด
   * **Endpoint URL**: ระบุหน้าเว็บฝั่ง Frontend ที่ใช้ลงทะเบียนพนักงาน ตัวอย่างเช่น:
     `https://<your-subdomain>.ngrok-free.app/register` (หรือ URL สำหรับการลงทะเบียนของพนักงาน)
   * **Scopes**: ติ๊กเลือก `profile` และ `openid`
   * **Features**: เปิดใช้งาน **ScanQR** (หากต้องการให้พนักงานสแกน QR code ผ่าน LIFF ได้)
4. กด **Save**
5. ระบบจะแสดง **LIFF ID** (เช่น `2000000000-XXXXXXXX`) ให้คัดลอกเก็บไว้ (นี่คือ `LINE_LIFF_ID`)
6. ไปที่แท็บ **LINE Login settings**:
   * ในส่วน **Callback URL** ให้ใส่ URL ของระบบเช่นกัน (ปกติ LIFF จะจัดการ Redirect ให้อัตโนมัติ แต่การใส่ Callback URL สำรองไว้จะช่วยป้องกัน Error ได้)

---

## 3. การกรอกข้อมูลบนระบบ FutureSign

ผู้ดูแลระบบสามารถกำหนดค่าได้ 2 วิธีการ:

### วิธีที่ 1: ตั้งค่าผ่าน Admin Dashboard UI (แนะนำ)
1. ล็อกอินเข้าสู่ระบบ FutureSign ด้วยสิทธิ์ผู้ดูแลระบบ (Admin/Staff)
2. ไปที่เมนู **System Settings** (หน้าปรับแต่งระบบ)
3. เลื่อนลงมาที่เซกชัน **LINE OA & LIFF Integration Settings**
4. กรอกข้อมูลที่คัดลอกมา:
   * **LINE Channel Access Token**
   * **LINE Channel Secret**
   * **LINE LIFF ID**
5. คลิก **Save Changes** เพื่อบันทึกค่าลงในฐานข้อมูลโดยตรง ค่านี้จะมีผลใช้งานทันทีโดยไม่ต้อง Restart Server

> [!NOTE]
> เพื่อความปลอดภัย ข้อมูล Access Token และ Channel Secret จะถูกซ่อนและสลับเปิด-ปิดตาได้เฉพาะ Admin เท่านั้น และจะไม่แสดงผลผ่าน API สาธารณะ

### วิธีที่ 2: ตั้งค่าผ่าน Env Variable (สำหรับ Fallback หรือเครื่องจำลอง)
หากยังไม่ได้ตั้งค่าในฐานข้อมูล คุณสามารถกำหนดค่าลงในไฟล์ `.env` ของฝั่ง Backend (`backend/.env`) ได้ในลักษณะตัวสำรอง (Fallback) โดยระบบจะเลือกใช้ค่าจาก Database ก่อนเป็นหลัก และจะไม่มีความจำเป็นต้องกำหนดค่าในฝั่ง Frontend (`frontend/.env.local`) อีกต่อไปเนื่องจากระบบจะดาวน์โหลดการตั้งค่าจากหลังบ้านแบบไดนามิกโดยตรง:
```env
LINE_CHANNEL_ACCESS_TOKEN=your_token_here
LINE_CHANNEL_SECRET=your_secret_here
LINE_LIFF_ID=your_liff_id_here
```

---

## 4. ข้อแนะนำสำหรับการพัฒนาบนเครื่องจำลอง (Local Development & ngrok)

เมื่อทดสอบระบบบนเครื่องตัวเองผ่าน ngrok คุณอาจเจอปัญหาหน้าจอยืนยันคำเตือนของ ngrok (ngrok-skip-browser-warning) เมื่อบอทเรียก Webhook หรือเมื่อโหลดหน้า LIFF

### การแก้ไขและข้ามหน้า ngrok warning:
เราได้ทำการเพิ่ม Middleware หรือจัดการแก้ไขการส่ง Request เพื่อความสะดวกในการพัฒนาแล้ว หรือคุณสามารถ:
1. ใส่ Request Header พิเศษ `ngrok-skip-browser-warning: true` ในการเรียกทดสอบผ่าน API Client (เช่น Postman)
2. เปิดหน้าเว็บ ngrok endpoint บนเบราว์เซอร์ของคุณก่อน แล้วกดปุ่ม "Visit Site" เพื่อยอมรับคำเตือนครั้งแรก จากนั้นเบราว์เซอร์จะจำสิทธิ์การเข้าถึง และเปิด LIFF ได้อย่างราบรื่น

---

## 5. การทดสอบความถูกต้องของระบบ (Verification checklist)

เมื่อตั้งค่าเสร็จแล้ว สามารถตรวจสอบการทำงานได้ดังนี้:
1. **Webhook verification**: ส่งข้อความสุ่มเข้าไลน์บอท -> บอทจะต้องตอบกลับ Flex Message แสดงปุ่ม "👉 เริ่มต้นลงทะเบียน 👈"
2. **LIFF Binding Flow**: คลิกปุ่มลงทะเบียนใน LINE -> หน้า LIFF จะเปิดหน้าสมัครสมาชิก -> เมื่อพนักงานกรอกรหัสพนักงานและกดลงทะเบียน -> สถานะการผูกบัญชีจะขึ้นเป็น `PENDING` ในแผงควบคุม
3. **Approval Notification**: เมื่อ Admin กดอนุมัติการผูกบัญชีในหน้ารายการ -> พนักงานจะได้รับ Push Notification ต้อนรับเข้าสู่ระบบโดยอัตโนมัติ
