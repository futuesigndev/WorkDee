from fastapi import Depends, HTTPException, Cookie, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import LocalUser, RoleMenuPermission, LocalMenu, LocalRole
from jose import jwt
from app.config import settings

async def get_current_user_id(access_token: str = Cookie(None)):
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(access_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM], options={"verify_signature": False})
        return payload.get("sub") # employee_id
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

async def require_permission(menu_key: str):
    async def permission_checker(
        employee_id: str = Depends(get_current_user_id),
        db: AsyncSession = Depends(get_db)
    ):
        # 1. Get user role
        stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
        
        if not user or not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")

        # 2. Check menu permission
        stmt = (
            select(RoleMenuPermission)
            .join(LocalMenu, RoleMenuPermission.menu_id == LocalMenu.id)
            .where(RoleMenuPermission.role_id == user.role_id)
            .where(LocalMenu.key == menu_key)
            .where(RoleMenuPermission.can_access == True)
        )
        result = await db.execute(stmt)
        permission = result.scalar_one_or_none()
        
        if not permission:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
            
        return user
        
    return permission_checker
