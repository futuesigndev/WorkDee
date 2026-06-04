from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models import LocalRole, LocalMenu, AppSettings, RoleMenuPermission

async def seed_data(db: AsyncSession):
    # 1. Seed Roles
    roles = [
        {"name": "Admin", "description": "System Administrator with full access", "is_system_role": True},
        {"name": "Supervisor", "description": "Team leader with management access", "is_system_role": False},
        {"name": "User", "description": "General employee", "is_system_role": False},
    ]
    
    for r_data in roles:
        stmt = select(LocalRole).where(LocalRole.name == r_data["name"])
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if not existing:
            db.add(LocalRole(**r_data))
    
    await db.flush()

    # 2. Seed Menus (Hierarchical Structure)
    # Define Top-level menus first
    main_menus = [
        {"key": "dashboard", "label": "Dashboard", "path": "/dashboard", "icon": "LayoutDashboard", "order": 1, "parent_id": None},
        {"key": "settings", "label": "System Settings", "path": "/dashboard/settings", "icon": "Settings", "order": 99, "parent_id": None},
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
            existing.label = m_data["label"]
            existing.path = m_data["path"]
            existing.order = m_data["order"]
            existing.icon = m_data["icon"]
            existing.parent_id = None
            await db.flush()
            menu_map[m_data["key"]] = existing.id

    # Define Child menus under "System Settings"
    settings_id = menu_map.get("settings")
    child_menus = [
        {"key": "users", "label": "User Management", "path": "/dashboard/users", "icon": "Users", "order": 1, "parent_id": settings_id},
        {"key": "roles", "label": "Roles & Permissions", "path": "/dashboard/roles", "icon": "ShieldCheck", "order": 2, "parent_id": settings_id},
        {"key": "menus", "label": "Menu Management", "path": "/dashboard/menus", "icon": "Layers", "order": 3, "parent_id": settings_id},
        {"key": "theme", "label": "Theme & Branding", "path": "/dashboard/settings", "icon": "Palette", "order": 4, "parent_id": settings_id},
        {"key": "line", "label": "LINE Approval", "path": "/dashboard/line", "icon": "MessageSquare", "order": 5, "parent_id": settings_id},
        {"key": "logs", "label": "Activity Logs", "path": "/dashboard/logs", "icon": "History", "order": 6, "parent_id": settings_id},
    ]

    for c_data in child_menus:
        stmt = select(LocalMenu).where(LocalMenu.key == c_data["key"])
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if not existing:
            db.add(LocalMenu(**c_data))
        else:
            existing.label = c_data["label"]
            existing.path = c_data["path"]
            existing.order = c_data["order"]
            existing.icon = c_data["icon"]
            existing.parent_id = settings_id
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
            app_name="FutureSign Template",
            theme="minimalist-slate",
            branding_text="Empowering Digital Enterprise"
        ))

    await db.commit()
