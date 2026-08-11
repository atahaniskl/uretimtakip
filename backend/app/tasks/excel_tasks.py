"""
Celery tasks for Excel processing.
Heavy Excel operations can be offloaded to background workers.
"""

import io
import logging

from app.celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, name="tasks.process_excel_upload")
def process_excel_upload(self, file_key: str, template_id: str, user_id: str):
    """
    Background task for processing large Excel files.
    This is an alternative to the synchronous /diff endpoint for files
    that may take too long to process in a single request.

    Args:
        file_key: MinIO object key of the uploaded file.
        template_id: UUID string of the mapping template.
        user_id: UUID string of the user who initiated the upload.
    """
    logger.info(
        f"Processing Excel file: {file_key} with template: {template_id}"
    )

    try:
        # Update task state
        self.update_state(state="PROCESSING", meta={"file_key": file_key})

        # NOTE: This task runs synchronously in the Celery worker.
        # For DB access, we use synchronous SQLAlchemy here.
        # The full implementation will be connected when async
        # workloads need to be offloaded.

        self.update_state(
            state="COMPLETED",
            meta={
                "file_key": file_key,
                "message": "Excel processing completed",
            },
        )

        return {
            "file_key": file_key,
            "status": "completed",
        }

    except Exception as exc:
        logger.error(f"Excel processing failed: {exc}")
        self.update_state(
            state="FAILED",
            meta={"file_key": file_key, "error": str(exc)},
        )
        raise


@celery_app.task(name="tasks.cleanup_old_files")
def cleanup_old_files(days: int = 30):
    """
    Periodic task to clean up old uploaded files from MinIO.
    Can be scheduled via Celery Beat.
    """
    logger.info(f"Cleaning up files older than {days} days")
    # Implementation will iterate MinIO objects and remove old ones
    return {"status": "completed", "days": days}
