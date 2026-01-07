#!/usr/bin/env python3
"""
Google Cloud Storage Upload Script

This script uploads files to Google Cloud Storage using service account authentication.
It supports single file uploads, directory uploads, and various configuration options.

Usage:
    python gcs_upload.py <bucket_name> <source_path> [destination_path] [options]

Examples:
    # Upload a single file
    python gcs_upload.py my-bucket ./file.pdf

    # Upload a file with custom destination name
    python gcs_upload.py my-bucket ./file.pdf documents/renamed.pdf

    # Upload an entire directory
    python gcs_upload.py my-bucket ./my_folder --recursive

    # Upload with custom content type
    python gcs_upload.py my-bucket ./data.json --content-type application/json

Author: Automation Engineering
Project: Manufacturing Assembly Instructions
"""

import os
import sys
import argparse
import mimetypes
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime

from google.cloud import storage
from google.cloud.exceptions import GoogleCloudError
from google.oauth2 import service_account

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Default paths and configuration
SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_CREDENTIALS_PATH = SCRIPT_DIR / "upload.json"
DEFAULT_BUCKET = "automationstationddata"


class GCSUploader:
    """
    Google Cloud Storage Uploader class.

    Handles authentication and file uploads to GCS buckets using
    service account credentials.
    """

    def __init__(
        self,
        credentials_path: Optional[str] = None,
        project_id: Optional[str] = None
    ):
        """
        Initialize the GCS uploader.

        Args:
            credentials_path: Path to the service account JSON key file.
                            If None, uses the default path (upload.json).
            project_id: GCP project ID. If None, uses the one from credentials.
        """
        self.credentials_path = Path(credentials_path or DEFAULT_CREDENTIALS_PATH)
        self._validate_credentials()

        # Load credentials
        self.credentials = service_account.Credentials.from_service_account_file(
            str(self.credentials_path),
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )

        # Initialize storage client
        self.client = storage.Client(
            credentials=self.credentials,
            project=project_id or self.credentials.project_id
        )

        logger.info(f"Initialized GCS client for project: {self.client.project}")

    def _validate_credentials(self) -> None:
        """Validate that the credentials file exists and is readable."""
        if not self.credentials_path.exists():
            raise FileNotFoundError(
                f"Credentials file not found: {self.credentials_path}\n"
                "Please ensure upload.json exists in the upload directory."
            )

        if not self.credentials_path.is_file():
            raise ValueError(f"Credentials path is not a file: {self.credentials_path}")

    def upload_file(
        self,
        bucket_name: str,
        source_path: str,
        destination_blob_name: Optional[str] = None,
        content_type: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None,
        make_public: bool = False,
        overwrite: bool = True
    ) -> Dict[str, Any]:
        """
        Upload a single file to Google Cloud Storage.

        Args:
            bucket_name: Name of the GCS bucket.
            source_path: Local path to the file to upload.
            destination_blob_name: Name for the blob in GCS.
                                  If None, uses the source filename.
            content_type: MIME type of the file. If None, auto-detected.
            metadata: Custom metadata to attach to the blob.
            make_public: If True, makes the blob publicly accessible.
            overwrite: If True, overwrites existing blobs. If False, skips if exists.

        Returns:
            Dictionary containing upload details (url, size, etc.)

        Raises:
            FileNotFoundError: If source file doesn't exist.
            GoogleCloudError: If upload fails.
        """
        source_path = Path(source_path).resolve()

        if not source_path.exists():
            raise FileNotFoundError(f"Source file not found: {source_path}")

        if not source_path.is_file():
            raise ValueError(f"Source path is not a file: {source_path}")

        # Use filename if no destination specified
        if destination_blob_name is None:
            destination_blob_name = source_path.name

        # Auto-detect content type if not specified
        if content_type is None:
            content_type, _ = mimetypes.guess_type(str(source_path))
            content_type = content_type or "application/octet-stream"

        # Get bucket and blob
        bucket = self.client.bucket(bucket_name)
        blob = bucket.blob(destination_blob_name)

        # Check if blob exists when overwrite is False
        if not overwrite and blob.exists():
            logger.warning(f"Blob already exists, skipping: {destination_blob_name}")
            return {
                "status": "skipped",
                "reason": "blob_exists",
                "destination": destination_blob_name
            }

        # Set metadata if provided
        if metadata:
            blob.metadata = metadata

        # Get file size for logging
        file_size = source_path.stat().st_size
        file_size_mb = file_size / (1024 * 1024)

        logger.info(f"Uploading: {source_path.name} ({file_size_mb:.2f} MB)")
        logger.info(f"  -> gs://{bucket_name}/{destination_blob_name}")

        try:
            # Use generation match precondition to avoid race conditions
            # 0 means the object should not exist (for new uploads)
            generation_match = 0 if not overwrite else None

            # Upload the file
            blob.upload_from_filename(
                str(source_path),
                content_type=content_type,
                if_generation_match=generation_match if not overwrite else None
            )

            # Make public if requested
            if make_public:
                blob.make_public()
                public_url = blob.public_url
            else:
                public_url = None

            # Build result
            result = {
                "status": "success",
                "source": str(source_path),
                "destination": destination_blob_name,
                "bucket": bucket_name,
                "size_bytes": file_size,
                "content_type": content_type,
                "gs_uri": f"gs://{bucket_name}/{destination_blob_name}",
                "public_url": public_url,
                "uploaded_at": datetime.utcnow().isoformat()
            }

            logger.info(f"Upload successful: {destination_blob_name}")
            return result

        except GoogleCloudError as e:
            logger.error(f"Upload failed: {e}")
            raise

    def upload_directory(
        self,
        bucket_name: str,
        source_dir: str,
        destination_prefix: str = "",
        pattern: str = "*",
        recursive: bool = True,
        content_type: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None,
        make_public: bool = False,
        overwrite: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Upload all files from a directory to Google Cloud Storage.

        Args:
            bucket_name: Name of the GCS bucket.
            source_dir: Local directory containing files to upload.
            destination_prefix: Prefix to add to all destination blob names.
            pattern: Glob pattern to filter files (e.g., "*.pdf", "*.json").
            recursive: If True, includes files in subdirectories.
            content_type: MIME type for all files. If None, auto-detected per file.
            metadata: Custom metadata to attach to all blobs.
            make_public: If True, makes all blobs publicly accessible.
            overwrite: If True, overwrites existing blobs.

        Returns:
            List of upload result dictionaries.
        """
        source_dir = Path(source_dir).resolve()

        if not source_dir.exists():
            raise FileNotFoundError(f"Source directory not found: {source_dir}")

        if not source_dir.is_dir():
            raise ValueError(f"Source path is not a directory: {source_dir}")

        # Find files matching pattern
        if recursive:
            files = list(source_dir.rglob(pattern))
        else:
            files = list(source_dir.glob(pattern))

        # Filter to only files (not directories)
        files = [f for f in files if f.is_file()]

        if not files:
            logger.warning(f"No files found matching pattern '{pattern}' in {source_dir}")
            return []

        logger.info(f"Found {len(files)} file(s) to upload")

        results = []
        for file_path in files:
            # Calculate relative path for destination
            relative_path = file_path.relative_to(source_dir)
            destination = str(Path(destination_prefix) / relative_path) if destination_prefix else str(relative_path)

            # Normalize path separators for GCS
            destination = destination.replace("\\", "/")

            try:
                result = self.upload_file(
                    bucket_name=bucket_name,
                    source_path=str(file_path),
                    destination_blob_name=destination,
                    content_type=content_type,
                    metadata=metadata,
                    make_public=make_public,
                    overwrite=overwrite
                )
                results.append(result)
            except Exception as e:
                logger.error(f"Failed to upload {file_path}: {e}")
                results.append({
                    "status": "error",
                    "source": str(file_path),
                    "error": str(e)
                })

        # Summary
        successful = sum(1 for r in results if r.get("status") == "success")
        skipped = sum(1 for r in results if r.get("status") == "skipped")
        failed = sum(1 for r in results if r.get("status") == "error")

        logger.info(f"\nUpload Summary:")
        logger.info(f"  Successful: {successful}")
        logger.info(f"  Skipped: {skipped}")
        logger.info(f"  Failed: {failed}")

        return results

    def list_buckets(self) -> List[str]:
        """List all buckets in the project."""
        buckets = list(self.client.list_buckets())
        return [b.name for b in buckets]

    def list_blobs(
        self,
        bucket_name: str,
        prefix: Optional[str] = None,
        max_results: int = 100
    ) -> List[Dict[str, Any]]:
        """
        List blobs in a bucket.

        Args:
            bucket_name: Name of the GCS bucket.
            prefix: Filter blobs by prefix.
            max_results: Maximum number of results to return.

        Returns:
            List of blob information dictionaries.
        """
        bucket = self.client.bucket(bucket_name)
        blobs = bucket.list_blobs(prefix=prefix, max_results=max_results)

        return [
            {
                "name": blob.name,
                "size": blob.size,
                "content_type": blob.content_type,
                "updated": blob.updated.isoformat() if blob.updated else None,
                "gs_uri": f"gs://{bucket_name}/{blob.name}"
            }
            for blob in blobs
        ]


def main():
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(
        description="Upload files to Google Cloud Storage",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Upload a single file:
    python gcs_upload.py my-bucket ./document.pdf

  Upload with custom destination:
    python gcs_upload.py my-bucket ./local.pdf remote/path/file.pdf

  Upload a directory recursively:
    python gcs_upload.py my-bucket ./folder --recursive

  Upload only PDF files:
    python gcs_upload.py my-bucket ./docs --recursive --pattern "*.pdf"

  List available buckets:
    python gcs_upload.py --list-buckets

  List files in a bucket:
    python gcs_upload.py my-bucket --list
        """
    )

    parser.add_argument(
        "bucket_name",
        nargs="?",
        default=DEFAULT_BUCKET,
        help=f"Name of the GCS bucket (default: {DEFAULT_BUCKET})"
    )

    parser.add_argument(
        "source",
        nargs="?",
        help="Local file or directory to upload"
    )

    parser.add_argument(
        "destination",
        nargs="?",
        help="Destination path in GCS (optional)"
    )

    parser.add_argument(
        "--credentials", "-c",
        default=None,
        help=f"Path to service account JSON (default: {DEFAULT_CREDENTIALS_PATH})"
    )

    parser.add_argument(
        "--recursive", "-r",
        action="store_true",
        help="Upload directory contents recursively"
    )

    parser.add_argument(
        "--pattern", "-p",
        default="*",
        help="Glob pattern for filtering files (default: *)"
    )

    parser.add_argument(
        "--content-type", "-t",
        default=None,
        help="Content type for uploaded files (auto-detected if not specified)"
    )

    parser.add_argument(
        "--public",
        action="store_true",
        help="Make uploaded files publicly accessible"
    )

    parser.add_argument(
        "--no-overwrite",
        action="store_true",
        help="Skip files that already exist in the bucket"
    )

    parser.add_argument(
        "--list-buckets",
        action="store_true",
        help="List available buckets and exit"
    )

    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List files in the specified bucket"
    )

    parser.add_argument(
        "--prefix",
        default=None,
        help="Prefix filter for listing blobs"
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose output"
    )

    args = parser.parse_args()

    # Set logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        # Initialize uploader
        uploader = GCSUploader(credentials_path=args.credentials)

        # Handle list-buckets
        if args.list_buckets:
            buckets = uploader.list_buckets()
            print("\nAvailable buckets:")
            for bucket in buckets:
                print(f"  - {bucket}")
            return 0

        # Validate bucket_name for other operations
        if not args.bucket_name:
            parser.error("bucket_name is required for upload/list operations")

        # Handle list blobs
        if args.list:
            blobs = uploader.list_blobs(args.bucket_name, prefix=args.prefix)
            print(f"\nBlobs in gs://{args.bucket_name}:")
            for blob in blobs:
                size_kb = blob['size'] / 1024 if blob['size'] else 0
                print(f"  {blob['name']} ({size_kb:.1f} KB)")
            return 0

        # Validate source for upload
        if not args.source:
            parser.error("source path is required for upload")

        source_path = Path(args.source).resolve()

        # Determine if uploading file or directory
        if source_path.is_dir() or args.recursive:
            results = uploader.upload_directory(
                bucket_name=args.bucket_name,
                source_dir=str(source_path),
                destination_prefix=args.destination or "",
                pattern=args.pattern,
                recursive=args.recursive,
                content_type=args.content_type,
                make_public=args.public,
                overwrite=not args.no_overwrite
            )

            # Exit with error if any uploads failed
            if any(r.get("status") == "error" for r in results):
                return 1
        else:
            result = uploader.upload_file(
                bucket_name=args.bucket_name,
                source_path=str(source_path),
                destination_blob_name=args.destination,
                content_type=args.content_type,
                make_public=args.public,
                overwrite=not args.no_overwrite
            )

            if result.get("status") == "error":
                return 1

            # Print the GCS URI for easy copy/paste
            if result.get("gs_uri"):
                print(f"\nUploaded to: {result['gs_uri']}")

        return 0

    except FileNotFoundError as e:
        logger.error(str(e))
        return 1
    except GoogleCloudError as e:
        logger.error(f"Google Cloud error: {e}")
        return 1
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
