"""
MinIO Object Storage Service.
Upload .xlsx to MinIO.
"""

import io
import uuid
from datetime import datetime, timezone

from minio import Minio
from minio.error import S3Error

from app.config import settings


class MinIOService:
    """Wrapper around the MinIO Python client for file operations."""

    def __init__(self):
        self.client = Minio(
            endpoint=settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE,
        )
        self.bucket_name = settings.MINIO_BUCKET_NAME

    async def ensure_bucket(self) -> None:
        """Create the default bucket if it doesn't exist."""
        if not self.client.bucket_exists(self.bucket_name):
            self.client.make_bucket(self.bucket_name)

    async def upload_file(
        self,
        file_data: bytes,
        original_filename: str,
        content_type: str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ) -> str:
        """
        Upload a file to MinIO and return the object name (storage key).
        Files are stored with a unique prefix to avoid collisions.
        """
        await self.ensure_bucket()

        # Generate unique object name: uploads/2026/04/19/<uuid>_<original_name>
        now = datetime.now(timezone.utc)
        date_prefix = now.strftime("%Y/%m/%d")
        unique_id = uuid.uuid4().hex[:12]
        object_name = f"uploads/{date_prefix}/{unique_id}_{original_filename}"

        file_stream = io.BytesIO(file_data)
        file_size = len(file_data)

        self.client.put_object(
            bucket_name=self.bucket_name,
            object_name=object_name,
            data=file_stream,
            length=file_size,
            content_type=content_type,
        )

        return object_name

    async def download_file(self, object_name: str) -> bytes:
        """Download a file from MinIO and return its content as bytes."""
        try:
            response = self.client.get_object(
                bucket_name=self.bucket_name,
                object_name=object_name,
            )
            data = response.read()
            response.close()
            response.release_conn()
            return data
        except S3Error as e:
            raise FileNotFoundError(
                f"File not found in storage: {object_name}"
            ) from e

    async def delete_file(self, object_name: str) -> None:
        """Delete a file from MinIO."""
        try:
            self.client.remove_object(
                bucket_name=self.bucket_name,
                object_name=object_name,
            )
        except S3Error as e:
            raise FileNotFoundError(
                f"File not found in storage: {object_name}"
            ) from e

    async def get_presigned_url(self, object_name: str, expires_hours: int = 1) -> str:
        """Generate a presigned URL for temporary direct access."""
        from datetime import timedelta
        return self.client.presigned_get_object(
            bucket_name=self.bucket_name,
            object_name=object_name,
            expires=timedelta(hours=expires_hours),
        )

    async def upload_backup(self, file_data: bytes, backup_name: str) -> str:
        """Upload a database backup to MinIO under the backups/ prefix."""
        await self.ensure_bucket()
        object_name = f"backups/{backup_name}"
        file_stream = io.BytesIO(file_data)
        self.client.put_object(
            bucket_name=self.bucket_name,
            object_name=object_name,
            data=file_stream,
            length=len(file_data),
            content_type="application/octet-stream",
        )
        return object_name

    async def list_backups(self) -> list[dict]:
        """Return backup objects sorted by newest first."""
        await self.ensure_bucket()
        objects = self.client.list_objects(
            bucket_name=self.bucket_name,
            prefix="backups/",
            recursive=True,
        )

        backups: list[dict] = []
        for obj in objects:
            if obj.is_dir:
                continue
            backups.append(
                {
                    "object_name": obj.object_name,
                    "size": obj.size,
                    "last_modified": obj.last_modified,
                }
            )

        backups.sort(key=lambda b: b["last_modified"], reverse=True)
        return backups

    async def delete_backup(self, object_name: str) -> None:
        """Delete a backup object from MinIO."""
        try:
            self.client.remove_object(
                bucket_name=self.bucket_name,
                object_name=object_name,
            )
        except S3Error as e:
            raise FileNotFoundError(
                f"Backup not found in storage: {object_name}"
            ) from e


# Singleton instance
minio_service = MinIOService()
