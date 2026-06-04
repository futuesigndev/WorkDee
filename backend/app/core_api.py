import httpx
import logging
from typing import Any, Dict, Optional
from app.config import settings

logger = logging.getLogger(__name__)

class CoreAPIClient:
    def __init__(self):
        # ลบ trailing slash เพื่อป้องกัน double-slash ใน URL เช่น .co.th//api/...
        self.base_url = settings.CORE_API_URL.rstrip('/')
        self.headers = {
            "X-API-Key": settings.CORE_API_KEY,
            "Content-Type": "application/json"
        }

    async def login(self, employee_id: str, password: str) -> Dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/api/v1/auth/login",
                headers=self.headers,
                json={"employee_id": employee_id, "password": password}
            )
            if not response.is_success:
                logger.error(
                    f"[Core-API] Login failed | URL: {self.base_url} | "
                    f"Status: {response.status_code} | Body: {response.text}"
                )
                response.raise_for_status()
            return response.json()

    async def get_me(self, access_token: str) -> Dict[str, Any]:
        headers = self.headers.copy()
        headers["Authorization"] = f"Bearer {access_token}"
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/api/v1/auth/me",
                headers=headers
            )
            response.raise_for_status()
            return response.json()

    async def get_employee(self, access_token: str, employee_id: str) -> Dict[str, Any]:
        headers = self.headers.copy()
        headers["Authorization"] = f"Bearer {access_token}"
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/api/v1/employees/{employee_id}",
                headers=headers
            )
            response.raise_for_status()
            return response.json()

    async def search_employees(self, access_token: str, query: str) -> Dict[str, Any]:
        headers = self.headers.copy()
        headers["Authorization"] = f"Bearer {access_token}"
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/api/v1/employees",
                headers=headers,
                params={"q": query, "active": "true", "limit": 20}
            )
            response.raise_for_status()
            return response.json()

    async def refresh_token(self, refresh_token: str) -> Dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/api/v1/auth/refresh",
                headers=self.headers,
                json={"refresh_token": refresh_token}
            )
            response.raise_for_status()
            return response.json()

core_api_client = CoreAPIClient()
