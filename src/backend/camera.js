/**
 * Camera Module for Assembly Instructions Viewer
 *
 * Handles video recording with automatic fallback:
 * - Primary: Seeed Studio reCamera (RTSP stream)
 * - Fallback: Logitech USB webcam (V4L2)
 *
 * Records per-slide clips (GIF) and full session videos (MP4).
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

// Camera configurations
const CAMERAS = {
  recamera: {
    name: 'reCamera (RTSP)',
    type: 'rtsp',
    rtspUrl: 'rtsp://admin:admin@192.168.42.1:554/live',
    ip: '192.168.42.1',
    port: 554,
    webUrl: 'http://192.168.42.1/',
    timeout: 3000
  },
  logitech: {
    name: 'Logitech USB',
    type: 'v4l2',
    device: '/dev/video0',
    webUrl: null,  // No web interface
    timeout: 2000
  }
};

// Recording storage directory
const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'recordings');

// Active recording sessions
const activeSessions = new Map();

// Current active camera (cached)
let activeCamera = null;
let lastCameraCheck = 0;
const CAMERA_CHECK_INTERVAL = 10000; // Re-check every 10 seconds

/**
 * Ensure recordings directory exists
 */
function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

/**
 * Check if reCamera (RTSP) is available
 */
async function isReCameraAvailable() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(CAMERAS.recamera.timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(CAMERAS.recamera.port, CAMERAS.recamera.ip);
  });
}

/**
 * Check if Logitech USB camera is available
 */
async function isLogitechAvailable() {
  return new Promise((resolve) => {
    try {
      // Check if device exists
      if (!fs.existsSync(CAMERAS.logitech.device)) {
        resolve(false);
        return;
      }

      // Try to query the device
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-f', 'v4l2',
        '-i', CAMERAS.logitech.device,
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0'
      ], { timeout: CAMERAS.logitech.timeout });

      let hasOutput = false;

      ffprobe.stdout.on('data', () => {
        hasOutput = true;
      });

      ffprobe.on('close', (code) => {
        resolve(code === 0 || hasOutput);
      });

      ffprobe.on('error', () => {
        resolve(false);
      });

      // Timeout fallback
      setTimeout(() => {
        ffprobe.kill();
        resolve(fs.existsSync(CAMERAS.logitech.device));
      }, CAMERAS.logitech.timeout);

    } catch (error) {
      resolve(false);
    }
  });
}

/**
 * Get the best available camera (with caching)
 * Priority: reCamera > Logitech
 */
async function getAvailableCamera(forceCheck = false) {
  const now = Date.now();

  // Use cached result if recent
  if (!forceCheck && activeCamera && (now - lastCameraCheck) < CAMERA_CHECK_INTERVAL) {
    return activeCamera;
  }

  // Check reCamera first (primary)
  const reCameraAvailable = await isReCameraAvailable();
  if (reCameraAvailable) {
    activeCamera = { ...CAMERAS.recamera, id: 'recamera' };
    lastCameraCheck = now;
    console.log('Using primary camera: reCamera (RTSP)');
    return activeCamera;
  }

  // Fallback to Logitech
  const logitechAvailable = await isLogitechAvailable();
  if (logitechAvailable) {
    activeCamera = { ...CAMERAS.logitech, id: 'logitech' };
    lastCameraCheck = now;
    console.log('Fallback to: Logitech USB camera');
    return activeCamera;
  }

  // No camera available
  activeCamera = null;
  lastCameraCheck = now;
  console.warn('No camera available');
  return null;
}

/**
 * Check if any camera is available
 */
async function isCameraAvailable() {
  const camera = await getAvailableCamera();
  return camera !== null;
}

/**
 * Get camera status with details
 */
async function getCameraStatus() {
  const reCameraAvailable = await isReCameraAvailable();
  const logitechAvailable = await isLogitechAvailable();

  const activeCamera = reCameraAvailable ? CAMERAS.recamera :
                       logitechAvailable ? CAMERAS.logitech : null;

  return {
    available: activeCamera !== null,
    activeCamera: activeCamera ? {
      name: activeCamera.name,
      type: activeCamera.type,
      webUrl: activeCamera.webUrl
    } : null,
    cameras: {
      recamera: {
        name: CAMERAS.recamera.name,
        available: reCameraAvailable,
        webUrl: CAMERAS.recamera.webUrl
      },
      logitech: {
        name: CAMERAS.logitech.name,
        available: logitechAvailable,
        device: CAMERAS.logitech.device
      }
    }
  };
}

/**
 * Build ffmpeg input arguments based on camera type
 */
function buildFfmpegInput(camera) {
  if (camera.type === 'rtsp') {
    return ['-rtsp_transport', 'tcp', '-i', camera.rtspUrl];
  } else if (camera.type === 'v4l2') {
    return ['-f', 'v4l2', '-framerate', '30', '-video_size', '1280x720', '-i', camera.device];
  }
  throw new Error(`Unknown camera type: ${camera.type}`);
}

/**
 * Start recording for a session
 * Records full session video continuously
 */
async function startSessionRecording(sessionId, serialNumber, stationId) {
  ensureRecordingsDir();

  const camera = await getAvailableCamera(true); // Force check
  if (!camera) {
    console.warn(`No camera available for session ${sessionId}`);
    return { success: false, error: 'No camera available' };
  }

  // Create session directory
  const sessionDir = path.join(RECORDINGS_DIR, `${serialNumber}_${stationId}`);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Full session video filename
  const fullVideoPath = path.join(sessionDir, `${serialNumber}_full.mp4`);

  // Build ffmpeg arguments based on camera type
  const inputArgs = buildFfmpegInput(camera);
  const ffmpegArgs = [
    ...inputArgs,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-c:a', 'aac',
    '-f', 'mp4',
    '-y',
    fullVideoPath
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`FFmpeg error for session ${sessionId}:`, err.message);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    // FFmpeg outputs to stderr, can be used for debugging
    // console.log(`FFmpeg: ${data}`);
  });

  // Store session info
  activeSessions.set(sessionId, {
    sessionId,
    serialNumber,
    stationId,
    sessionDir,
    fullVideoPath,
    ffmpegProcess,
    camera: camera,  // Track which camera is used
    currentPage: 1,
    pageStartTime: Date.now(),
    pageClips: [],
    startTime: Date.now()
  });

  console.log(`Started recording for session ${sessionId} (SN: ${serialNumber}) using ${camera.name}`);

  return {
    success: true,
    sessionDir,
    camera: camera.name,
    message: `Recording started with ${camera.name}`
  };
}

/**
 * Record a clip for the current page (when navigating away)
 * Creates a GIF from the recorded segment
 */
async function savePageClip(sessionId, pageNumber) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  const duration = Math.floor((Date.now() - session.pageStartTime) / 1000);
  if (duration < 1) {
    // Skip very short clips
    return { success: true, skipped: true };
  }

  // GIF filename: SN_page#.gif
  const gifFilename = `${session.serialNumber}_page${pageNumber}.gif`;
  const gifPath = path.join(session.sessionDir, gifFilename);

  // Capture a short clip and convert to GIF
  const clipDuration = Math.min(duration, 10); // Max 10 seconds per clip

  try {
    await captureGif(gifPath, clipDuration, session.camera);

    session.pageClips.push({
      page: pageNumber,
      filename: gifFilename,
      path: gifPath,
      duration: duration
    });

    console.log(`Saved page ${pageNumber} clip: ${gifFilename}`);
    return { success: true, filename: gifFilename };
  } catch (error) {
    console.error(`Error saving page clip:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Capture a GIF from the camera
 */
function captureGif(outputPath, duration = 5, camera = null) {
  return new Promise(async (resolve, reject) => {
    // Use provided camera or get available one
    if (!camera) {
      camera = await getAvailableCamera();
      if (!camera) {
        reject(new Error('No camera available'));
        return;
      }
    }

    const inputArgs = buildFfmpegInput(camera);
    const ffmpegArgs = [
      ...inputArgs,
      '-t', String(Math.min(duration, 5)), // Limit to 5 seconds for GIF
      '-vf', 'fps=10,scale=480:-1:flags=lanczos',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Capture a single snapshot from the camera
 */
async function captureSnapshot() {
  const camera = await getAvailableCamera();
  if (!camera) {
    throw new Error('No camera available');
  }

  return new Promise((resolve, reject) => {
    // Use temp file approach for more reliable capture
    const tempFile = `/tmp/snapshot_${Date.now()}.jpg`;

    const inputArgs = buildFfmpegInput(camera);
    const ffmpegArgs = [
      ...inputArgs,
      '-frames:v', '1',
      '-f', 'mjpeg',
      '-q:v', '5',
      '-y',
      tempFile
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempFile)) {
        try {
          const data = fs.readFileSync(tempFile);
          fs.unlinkSync(tempFile); // Clean up temp file
          resolve({
            data: data,
            camera: camera.name
          });
        } catch (err) {
          reject(new Error('Failed to read captured frame'));
        }
      } else {
        reject(new Error(`Failed to capture frame: ${stderr.slice(-100)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('Capture timeout'));
    }, 10000);
  });
}

/**
 * Mark page entry (reset page timer)
 */
function markPageEntry(sessionId, pageNumber) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.currentPage = pageNumber;
    session.pageStartTime = Date.now();
  }
}

/**
 * Stop recording for a session
 */
async function stopSessionRecording(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  // Stop the ffmpeg process gracefully
  if (session.ffmpegProcess) {
    session.ffmpegProcess.stdin.write('q'); // Send quit command

    // Wait for process to finish
    await new Promise((resolve) => {
      session.ffmpegProcess.on('close', resolve);
      // Force kill after timeout
      setTimeout(() => {
        session.ffmpegProcess.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }

  const totalDuration = Math.floor((Date.now() - session.startTime) / 1000);

  const result = {
    success: true,
    serialNumber: session.serialNumber,
    sessionDir: session.sessionDir,
    fullVideo: session.fullVideoPath,
    pageClips: session.pageClips,
    camera: session.camera?.name,
    totalDuration
  };

  // Clean up
  activeSessions.delete(sessionId);

  console.log(`Stopped recording for session ${sessionId}`);
  return result;
}

/**
 * Get recording info for a session
 */
function getSessionRecording(sessionId) {
  return activeSessions.get(sessionId) || null;
}

/**
 * List all recordings for a serial number
 */
function listRecordings(serialNumber, stationId) {
  const sessionDir = path.join(RECORDINGS_DIR, `${serialNumber}_${stationId}`);

  if (!fs.existsSync(sessionDir)) {
    return { files: [], sessionDir: null };
  }

  const files = fs.readdirSync(sessionDir).map(filename => {
    const filePath = path.join(sessionDir, filename);
    const stats = fs.statSync(filePath);
    return {
      filename,
      path: filePath,
      size: stats.size,
      created: stats.birthtime
    };
  });

  return { files, sessionDir };
}

/**
 * Get all recordings grouped by serial number
 */
function getAllRecordings() {
  ensureRecordingsDir();

  const recordings = [];
  const dirs = fs.readdirSync(RECORDINGS_DIR);

  for (const dir of dirs) {
    const dirPath = path.join(RECORDINGS_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const [serialNumber, stationId] = dir.split('_');
    const files = fs.readdirSync(dirPath).map(filename => {
      const filePath = path.join(dirPath, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        size: stats.size,
        created: stats.birthtime,
        isFullVideo: filename.includes('_full.'),
        isGif: filename.endsWith('.gif')
      };
    });

    recordings.push({
      serialNumber,
      stationId,
      directory: dir,
      files
    });
  }

  return recordings;
}

module.exports = {
  isCameraAvailable,
  getCameraStatus,
  getAvailableCamera,
  captureSnapshot,
  startSessionRecording,
  savePageClip,
  markPageEntry,
  stopSessionRecording,
  getSessionRecording,
  listRecordings,
  getAllRecordings,
  RECORDINGS_DIR,
  CAMERAS
};
