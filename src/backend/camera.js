/**
 * Camera Module for Assembly Instructions Viewer
 *
 * Handles video recording from Seeed Studio reCamera via RTSP stream.
 * Records per-slide clips (GIF) and full session videos (MP4).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Camera configuration
const CAMERA_CONFIG = {
  rtspUrl: 'rtsp://admin:admin@192.168.42.1:554/live',
  ip: '192.168.42.1',
  port: 554,
  timeout: 5000
};

// Recording storage directory
const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'recordings');

// Active recording sessions
const activeSessions = new Map();

/**
 * Ensure recordings directory exists
 */
function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

/**
 * Check if camera is reachable
 */
async function isCameraAvailable() {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();

    socket.setTimeout(CAMERA_CONFIG.timeout);

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

    socket.connect(CAMERA_CONFIG.port, CAMERA_CONFIG.ip);
  });
}

/**
 * Start recording for a session
 * Records full session video continuously
 */
async function startSessionRecording(sessionId, serialNumber, stationId) {
  ensureRecordingsDir();

  const available = await isCameraAvailable();
  if (!available) {
    console.warn(`Camera not available for session ${sessionId}`);
    return { success: false, error: 'Camera not available' };
  }

  // Create session directory
  const sessionDir = path.join(RECORDINGS_DIR, `${serialNumber}_${stationId}`);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Full session video filename
  const fullVideoPath = path.join(sessionDir, `${serialNumber}_full.mp4`);

  // Start ffmpeg for full session recording
  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-i', CAMERA_CONFIG.rtspUrl,
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
    currentPage: 1,
    pageStartTime: Date.now(),
    pageClips: [],
    startTime: Date.now()
  });

  console.log(`Started recording for session ${sessionId} (SN: ${serialNumber})`);

  return {
    success: true,
    sessionDir,
    message: 'Recording started'
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

  // Capture a short clip from RTSP and convert to GIF
  // We'll capture the last few seconds as a representative clip
  const clipDuration = Math.min(duration, 10); // Max 10 seconds per clip

  try {
    await captureGif(gifPath, clipDuration);

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
 * Capture a GIF from the RTSP stream
 */
function captureGif(outputPath, duration = 5) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-rtsp_transport', 'tcp',
      '-t', String(Math.min(duration, 5)), // Limit to 5 seconds for GIF
      '-i', CAMERA_CONFIG.rtspUrl,
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
  startSessionRecording,
  savePageClip,
  markPageEntry,
  stopSessionRecording,
  getSessionRecording,
  listRecordings,
  getAllRecordings,
  RECORDINGS_DIR
};
