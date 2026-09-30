from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select
from app.models import LocalRole, LocalMenu, AppSettings, NewsCategory, RoleMenuPermission

# ── Default company-news categories (task 036) ────────────────────────────────
# The starting set HR then edits in the admin page: (name, sort_order). Seeded **only** when
# `news_categories` is empty, so a rename, a reorder or a deactivation survives every restart, and
# deactivating all six cannot bring them back (the table is still not empty).
DEFAULT_NEWS_CATEGORIES: tuple[tuple[str, int], ...] = (
    ("ประกาศทั่วไป", 10),
    ("นโยบายและระเบียบ", 20),
    ("สวัสดิการ", 30),
    ("กิจกรรมบริษัท", 40),
    ("ความปลอดภัย", 50),
    ("ด่วน", 60),
)

async def seed_data(db: AsyncSession):
    # 1. Seed Roles
    roles = [
        {"name": "Admin", "description": "ผู้ดูแลระบบ เข้าถึงได้ทุกเมนู", "is_system_role": True},
        {"name": "Supervisor", "description": "หัวหน้าทีม ดูแลงานของทีม", "is_system_role": False},
        {"name": "User", "description": "พนักงานทั่วไป", "is_system_role": False},
    ]
    
    for r_data in roles:
        stmt = select(LocalRole).where(LocalRole.name == r_data["name"])
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if not existing:
            db.add(LocalRole(**r_data))
    
    await db.flush()

    # 2. Seed Menus (Hierarchical Structure)
    # Labels are Thai (CONTEXT.md standing rule: user-visible text is Thai). Note that an EXISTING row
    # only gets path/order/icon/parent_id refreshed — never `label`: HR can rename menus in the Menus
    # page, and a startup must not undo that. Only a brand-new row is inserted with the label below.
    # Define Top-level menus first
    main_menus = [
        {"key": "dashboard", "label": "ภาพรวม", "path": "/dashboard", "icon": "LayoutDashboard", "order": 1, "parent_id": None},
        {"key": "operation", "label": "งานประจำวัน", "path": "/dashboard/operation", "icon": "Briefcase", "order": 2, "parent_id": None},
        {"key": "report", "label": "รายงาน", "path": "/dashboard/report", "icon": "BarChart2", "order": 3, "parent_id": None},
        {"key": "config-app", "label": "ตั้งค่าการลงเวลา", "path": "/dashboard/config-app", "icon": "Link2", "order": 4, "parent_id": None},
        {"key": "settings", "label": "ตั้งค่าระบบ", "path": "/dashboard/settings", "icon": "Settings", "order": 99, "parent_id": None},
    ]

    menu_map = {} # To store ID for children

    for m_data in main_menus:
        stmt = select(LocalMenu).where(LocalMenu.key == m_data["key"])
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if not existing:
            new_menu = LocalMenu(**m_data)
            db.add(new_menu)
            await db.flush()
            menu_map[m_data["key"]] = new_menu.id
        else:
            existing.path = m_data["path"]
            existing.order = m_data["order"]
            existing.icon = m_data["icon"]
            existing.parent_id = None
            await db.flush()
            menu_map[m_data["key"]] = existing.id

    # Define Child menus. Each entry carries its own parent_id, so a menu is moved between
    # top-level groups by changing only that field (fix round 2 moved "LINE Approval" out of
    # "System Settings" into the new "Config App" group).
    settings_id = menu_map.get("settings")
    config_app_id = menu_map.get("config-app")
    operation_id = menu_map.get("operation")
    child_menus = [
        {"key": "users", "label": "ผู้ใช้งาน", "path": "/dashboard/users", "icon": "Users", "order": 1, "parent_id": settings_id},
        {"key": "roles", "label": "บทบาทและสิทธิ์", "path": "/dashboard/roles", "icon": "ShieldCheck", "order": 2, "parent_id": settings_id},
        {"key": "menus", "label": "จัดการเมนู", "path": "/dashboard/menus", "icon": "Layers", "order": 3, "parent_id": settings_id},
        {"key": "theme", "label": "ธีมและชื่อระบบ", "path": "/dashboard/settings", "icon": "Palette", "order": 4, "parent_id": settings_id},
        {"key": "logs", "label": "บันทึกการใช้งาน", "path": "/dashboard/logs", "icon": "History", "order": 5, "parent_id": settings_id},
        {"key": "line", "label": "ผูกบัญชี LINE", "path": "/dashboard/line", "icon": "MessageSquare", "order": 1, "parent_id": config_app_id},
        {"key": "locations", "label": "สถานที่ทำงาน", "path": "/dashboard/config-app/locations", "icon": "Globe", "order": 2, "parent_id": config_app_id},
        {"key": "attendance-templates", "label": "แม่แบบรอบลงเวลา", "path": "/dashboard/config-app/attendance-templates", "icon": "FileText", "order": 3, "parent_id": config_app_id},
        {"key": "work-profiles", "label": "โปรไฟล์การทำงาน", "path": "/dashboard/config-app/work-profiles", "icon": "Users", "order": 4, "parent_id": config_app_id},
        # Task 022. Under **Operation**, not Config App: this is the daily HR work of looking at
        # records and clearing flags, whereas Config App holds the setup pages (locations, round
        # templates, work profiles). It is also the group an employee-facing result belongs to, and
        # it keeps the three setup pages together.
        {"key": "attendance-records", "label": "รายการลงเวลา", "path": "/dashboard/operation/attendance-records", "icon": "ClipboardCheck", "order": 1, "parent_id": operation_id},
        # Task 036. Same Operation group (HR's daily work, not setup), ordered right after the
        # records page. The icon name must exist in the shell's `IconMap` (`dashboard/layout.tsx`),
        # otherwise the sidebar silently falls back to a plain circle — `FileText` is already there.
        {"key": "news", "label": "ข่าวสารองค์กร", "path": "/dashboard/operation/news", "icon": "FileText", "order": 2, "parent_id": operation_id},
    ]

    for c_data in child_menus:
        stmt = select(LocalMenu).where(LocalMenu.key == c_data["key"])
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if not existing:
            db.add(LocalMenu(**c_data))
        else:
            # `label` is deliberately NOT refreshed — see the note above the menu lists.
            existing.path = c_data["path"]
            existing.order = c_data["order"]
            existing.icon = c_data["icon"]
            existing.parent_id = c_data["parent_id"]
        await db.flush()

    # Commit roles and menus
    await db.commit()

    # 3. Grant all menus to Admin by default
    admin_stmt = select(LocalRole).where(LocalRole.name == "Admin")
    admin_role = (await db.execute(admin_stmt)).scalar_one()
    
    all_menus_stmt = select(LocalMenu)
    all_menus = (await db.execute(all_menus_stmt)).scalars().all()
    
    for menu in all_menus:
        perm_stmt = select(RoleMenuPermission).where(
            RoleMenuPermission.role_id == admin_role.id,
            RoleMenuPermission.menu_id == menu.id
        )
        existing_perm = (await db.execute(perm_stmt)).scalar_one_or_none()
        if not existing_perm:
            db.add(RoleMenuPermission(role_id=admin_role.id, menu_id=menu.id, can_access=True))

    # 4. Seed App Settings if empty
    stmt = select(AppSettings)
    existing_settings = (await db.execute(stmt)).scalar_one_or_none()
    if not existing_settings:
        db.add(AppSettings(
            app_name="WorkDee",
            theme="minimalist-slate",
            branding_text="Empowering Digital Enterprise"
        ))

    await db.commit()

    # 5. Seed the default news categories — only when `news_categories` is empty (task 036).
    # The empty-table test is the whole rule: HR's own set is never touched again, and a table where
    # every row was deactivated still counts as "not empty", so nothing is resurrected.
    category_count = (await db.execute(select(func.count()).select_from(NewsCategory))).scalar() or 0
    if category_count == 0:
        for name, sort_order in DEFAULT_NEWS_CATEGORIES:
            db.add(NewsCategory(name=name, sort_order=sort_order))
        await db.commit()
