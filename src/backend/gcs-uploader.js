/**
 * GCS Uploader Module for Assembly Instructions Viewer
 *
 * Handles uploading session data (recordings, session data) to Google Cloud Storage.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./database');

// Configuration
const UPLOAD_SCRIPT = path.join(__dirname, '..', '..', 'upload', 'gcs_upload.py');
const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'recordings');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_BUCKET = 'automationstationddata';

// Track upload progress
const uploadProgress = new Map();

/**
 * Get list of files to upload for a session
 */
function getSessionFiles(serialNumber, stationId) {
  const files = [];
  const sessionDir = path.join(RECORDINGS_DIR, `${serialNumber}_${stationId}`);

  // Add recording files
  if (fs.existsSync(sessionDir)) {
    const recordingFiles = fs.readdirSync(sessionDir);
    for (const file of recordingFiles) {
      const filePath = path.join(sessionDir, file);
      const stats = fs.statSync(filePath);
      files.push({
        type: file.endsWith('.gif') ? 'gif' : file.endsWith('.mp4') ? 'video' : 'other',
        name: file,
        path: filePath,
        size: stats.size,
        destination: `recordings/${serialNumber}_${stationId}/${file}`
      });
    }
  }

  return files;
}

/**
 * Get all files to upload (all recordings and session data)
 * Uses timestamp-based folder structure to avoid overwrite permission issues
 */
function getAllUploadableFiles() {
  const files = [];

  // Create a timestamp for this upload batch (used in destination paths)
  const uploadTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Add all recording directories
  if (fs.existsSync(RECORDINGS_DIR)) {
    const dirs = fs.readdirSync(RECORDINGS_DIR);
    for (const dir of dirs) {
      const dirPath = path.join(RECORDINGS_DIR, dir);
      if (fs.statSync(dirPath).isDirectory()) {
        const recordingFiles = fs.readdirSync(dirPath);
        for (const file of recordingFiles) {
          const filePath = path.join(dirPath, file);
          const stats = fs.statSync(filePath);
          files.push({
            type: file.endsWith('.gif') ? 'gif' : file.endsWith('.mp4') ? 'video' : 'other',
            name: file,
            path: filePath,
            size: stats.size,
            destination: `recordings/${uploadTimestamp}/${dir}/${file}`
          });
        }
      }
    }
  }

  // Add session data files
  if (fs.existsSync(DATA_DIR)) {
    const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const file of dataFiles) {
      const filePath = path.join(DATA_DIR, file);
      const stats = fs.statSync(filePath);
      files.push({
        type: 'data',
        name: file,
        path: filePath,
        size: stats.size,
        destination: `session_data/${uploadTimestamp}/${file}`
      });
    }
  }

  return files;
}

/**
 * Upload a single file to GCS
 * Note: Uses timestamp-based unique paths to avoid overwrite permission issues
 */
function uploadFile(filePath, destination, bucket = DEFAULT_BUCKET) {
  return new Promise((resolve, reject) => {
    const args = [UPLOAD_SCRIPT, bucket, filePath, destination];

    const process = spawn('python3', args);

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          destination: `gs://${bucket}/${destination}`,
          output: stdout
        });
      } else {
        reject(new Error(`Upload failed: ${stderr || stdout}`));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Upload all files with progress tracking
 * @param {string} uploadId - Unique upload identifier
 * @param {string} bucket - GCS bucket name
 * @param {boolean} cleanupAfterUpload - Delete local files after successful upload
 */
async function uploadAllFiles(uploadId, bucket = DEFAULT_BUCKET, cleanupAfterUpload = true) {
  const files = getAllUploadableFiles();

  if (files.length === 0) {
    return {
      success: true,
      message: 'No files to upload',
      uploaded: 0,
      total: 0
    };
  }

  // Initialize progress
  uploadProgress.set(uploadId, {
    status: 'in_progress',
    total: files.length,
    completed: 0,
    failed: 0,
    currentFile: '',
    files: [],
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    uploadedBytes: 0,
    startTime: Date.now(),
    cleaned: 0
  });

  const results = [];
  const successfulFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Update progress
    const progress = uploadProgress.get(uploadId);
    progress.currentFile = file.name;
    uploadProgress.set(uploadId, progress);

    try {
      const result = await uploadFile(file.path, file.destination, bucket);
      results.push({
        file: file.name,
        destination: result.destination,
        success: true,
        size: file.size
      });

      successfulFiles.push(file);

      // Update progress
      progress.completed++;
      progress.uploadedBytes += file.size;
      progress.files.push({ name: file.name, success: true });
      uploadProgress.set(uploadId, progress);

    } catch (error) {
      results.push({
        file: file.name,
        error: error.message,
        success: false
      });

      // Update progress
      progress.failed++;
      progress.files.push({ name: file.name, success: false, error: error.message });
      uploadProgress.set(uploadId, progress);
    }
  }

  // Cleanup local files after successful upload
  // Only delete recording files (videos/GIFs), keep data files until database is cleared
  let cleanedCount = 0;
  let cleanedBytes = 0;
  if (cleanupAfterUpload && successfulFiles.length > 0) {
    const progress = uploadProgress.get(uploadId);
    progress.status = 'cleaning';
    progress.currentFile = 'Cleaning up local files...';
    uploadProgress.set(uploadId, progress);

    // Only delete recording files (type: gif, video, other from recordings dir)
    const recordingFiles = successfulFiles.filter(f => f.type !== 'data');

    for (const file of recordingFiles) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          cleanedCount++;
          cleanedBytes += file.size;
        }
      } catch (err) {
        console.error(`Failed to delete ${file.path}:`, err.message);
      }
    }

    // Clean up empty directories in recordings folder
    cleanupEmptyDirectories(RECORDINGS_DIR);

    // Clear the database (resets all session data)
    // This happens after data files are successfully uploaded to GCS
    const dataFilesUploaded = successfulFiles.filter(f => f.type === 'data').length;
    if (dataFilesUploaded > 0) {
      try {
        db.clearDatabase();
        progress.databaseCleared = true;
        console.log('Database cleared after successful upload');
      } catch (err) {
        console.error('Failed to clear database:', err.message);
        progress.databaseCleared = false;
      }
    }

    progress.cleaned = cleanedCount;
    progress.cleanedBytes = cleanedBytes;
    uploadProgress.set(uploadId, progress);
  }

  // Mark as complete
  const finalProgress = uploadProgress.get(uploadId);
  finalProgress.status = 'completed';
  finalProgress.endTime = Date.now();
  finalProgress.duration = (finalProgress.endTime - finalProgress.startTime) / 1000;
  uploadProgress.set(uploadId, finalProgress);

  return {
    success: finalProgress.failed === 0,
    uploaded: finalProgress.completed,
    failed: finalProgress.failed,
    total: files.length,
    duration: finalProgress.duration,
    cleaned: cleanedCount,
    cleanedBytes,
    results
  };
}

/**
 * Clean up empty directories recursively
 */
function cleanupEmptyDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      cleanupEmptyDirectories(fullPath);
      // Check if directory is now empty
      if (fs.readdirSync(fullPath).length === 0) {
        fs.rmdirSync(fullPath);
        console.log(`Removed empty directory: ${fullPath}`);
      }
    }
  }
}

/**
 * Get upload progress
 */
function getUploadProgress(uploadId) {
  return uploadProgress.get(uploadId) || null;
}

/**
 * Generate a unique upload ID
 */
function generateUploadId() {
  return `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  getSessionFiles,
  getAllUploadableFiles,
  uploadFile,
  uploadAllFiles,
  getUploadProgress,
  generateUploadId,
  DEFAULT_BUCKET
};
