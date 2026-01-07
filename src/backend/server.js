const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const camera = require('./camera');
const gcsUploader = require('./gcs-uploader');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to instruction folder (where PDFs are stored)
const INSTRUCTION_DIR = path.join(__dirname, '..', '..', 'instruction');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/pages', express.static(path.join(__dirname, '..', 'public', 'pages')));
// Serve PDFs from instruction folder
app.use('/pdf', express.static(INSTRUCTION_DIR));
// Serve recordings
app.use('/recordings', express.static(camera.RECORDINGS_DIR));

// Initialize database
db.initializeDatabase();

// Dynamically scan instruction folder for PDF files
function scanForStations() {
  const stations = {};

  if (!fs.existsSync(INSTRUCTION_DIR)) {
    console.warn(`Warning: Instruction directory not found: ${INSTRUCTION_DIR}`);
    return stations;
  }

  const files = fs.readdirSync(INSTRUCTION_DIR);
  const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

  for (const pdfFile of pdfFiles) {
    // Parse station ID from filename format: [M-XXXXXXX] Station Name (DELTA).pdf
    const match = pdfFile.match(/^\[([^\]]+)\]\s*(.+?)(?:\s*\([^)]+\))?\.pdf$/i);

    if (match) {
      const stationId = match[1];
      const stationName = match[2].trim();
      const documentName = pdfFile.replace('.pdf', '');

      stations[stationId] = {
        station_id: stationId,
        station_name: stationName,
        document_name: documentName,
        pdf_file: pdfFile,
        total_pages: null // Will be determined by PDF.js on client
      };
    }
  }

  return stations;
}

// Load stations from instruction folder
const STATIONS = scanForStations();

// Default station (first available or null)
const DEFAULT_STATION = Object.keys(STATIONS)[0] || null;

// API Routes

// Get all available stations
app.get('/api/stations', (req, res) => {
  const stationList = Object.values(STATIONS).map(s => ({
    station_id: s.station_id,
    station_name: s.station_name,
    document_name: s.document_name
  }));
  res.json(stationList);
});

// Get document info for a specific station
app.get('/api/document', (req, res) => {
  const stationId = req.query.station || DEFAULT_STATION;
  const station = STATIONS[stationId];

  if (!station) {
    return res.status(404).json({ error: 'Station not found' });
  }

  res.json({
    station_id: station.station_id,
    station_name: station.station_name,
    name: station.document_name,
    totalPages: station.total_pages,
    pdfFile: station.pdf_file
  });
});

// Start a new assembly session
app.post('/api/session/start', async (req, res) => {
  try {
    const { serialNumber, stationId } = req.body;
    const station = STATIONS[stationId || DEFAULT_STATION];

    if (!serialNumber) {
      return res.status(400).json({ error: 'Serial number is required' });
    }

    if (!station) {
      return res.status(400).json({ error: 'Invalid station' });
    }

    // Check if serial number was already used for a completed assembly at this station
    if (db.serialNumberExistsForStation(serialNumber, station.station_id)) {
      return res.status(400).json({
        error: 'Serial number already used',
        message: `This serial number has already been used for a completed assembly at station ${station.station_name}`
      });
    }

    const sessionId = uuidv4();
    db.createSession(
      sessionId,
      serialNumber,
      station.station_id,
      station.station_name,
      station.document_name,
      station.total_pages
    );

    // Start camera recording
    const cameraResult = await camera.startSessionRecording(sessionId, serialNumber, station.station_id);

    res.json({
      success: true,
      sessionId,
      serialNumber,
      stationId: station.station_id,
      stationName: station.station_name,
      documentName: station.document_name,
      totalPages: station.total_pages,
      pdfFile: station.pdf_file,
      recording: cameraResult.success
    });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// End assembly session
app.post('/api/session/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { finalPageVisitId, finalPage } = req.body;

    // Record exit from final page if provided
    if (finalPageVisitId) {
      db.recordPageExit(finalPageVisitId);
    }

    // Save final page clip and stop recording
    if (finalPage) {
      await camera.savePageClip(sessionId, finalPage);
    }
    const recordingResult = await camera.stopSessionRecording(sessionId);

    db.endSession(sessionId);
    const summary = db.getSessionSummary(sessionId);

    res.json({
      success: true,
      summary,
      recordings: recordingResult.success ? {
        fullVideo: recordingResult.fullVideo ? path.basename(recordingResult.fullVideo) : null,
        pageClips: recordingResult.pageClips || [],
        directory: recordingResult.sessionDir ? path.basename(recordingResult.sessionDir) : null
      } : null
    });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Record page entry
app.post('/api/session/:sessionId/page/enter', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { pageNumber, visitSequence, navigationDirection } = req.body;

    const visitId = db.recordPageEntry(sessionId, pageNumber, visitSequence, navigationDirection);

    // Mark page entry for camera
    camera.markPageEntry(sessionId, pageNumber);

    res.json({
      success: true,
      visitId
    });
  } catch (error) {
    console.error('Error recording page entry:', error);
    res.status(500).json({ error: 'Failed to record page entry' });
  }
});

// Record page exit
app.post('/api/session/:sessionId/page/exit', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { visitId, pageNumber, durationSeconds } = req.body;

    if (visitId) {
      db.recordPageExit(visitId);
    }

    if (pageNumber !== undefined && durationSeconds !== undefined) {
      db.updatePageTimeSummary(sessionId, pageNumber, durationSeconds);
    }

    // Save page clip when exiting a page
    if (pageNumber !== undefined) {
      camera.savePageClip(sessionId, pageNumber).catch(err => {
        console.error('Error saving page clip:', err);
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error recording page exit:', error);
    res.status(500).json({ error: 'Failed to record page exit' });
  }
});

// Log navigation
app.post('/api/session/:sessionId/navigate', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { fromPage, toPage, action, timeOnPreviousPage, cumulativeTime } = req.body;

    db.logNavigation(sessionId, fromPage, toPage, action, timeOnPreviousPage, cumulativeTime);

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging navigation:', error);
    res.status(500).json({ error: 'Failed to log navigation' });
  }
});

// Update page time summary
app.post('/api/session/:sessionId/page/time', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { pageNumber, durationSeconds } = req.body;

    db.updatePageTimeSummary(sessionId, pageNumber, durationSeconds);

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating page time:', error);
    res.status(500).json({ error: 'Failed to update page time' });
  }
});

// Get session details
app.get('/api/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Get session summary
app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const summary = db.getSessionSummary(sessionId);

    if (!summary.session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(summary);
  } catch (error) {
    console.error('Error getting session summary:', error);
    res.status(500).json({ error: 'Failed to get session summary' });
  }
});

// Get all sessions (optionally filtered by station)
app.get('/api/sessions', (req, res) => {
  try {
    const stationId = req.query.station;
    const sessions = stationId ? db.getSessionsByStation(stationId) : db.getAllSessions();
    res.json(sessions);
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Get sessions by serial number
app.get('/api/sessions/serial/:serialNumber', (req, res) => {
  try {
    const { serialNumber } = req.params;
    const sessions = db.getSessionsBySerialNumber(serialNumber);
    res.json(sessions);
  } catch (error) {
    console.error('Error getting sessions by serial:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Serve the main application
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Admin dashboard route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'admin.html'));
});

// ============ Camera API Routes ============

// Check camera availability
app.get('/api/camera/status', async (req, res) => {
  try {
    const available = await camera.isCameraAvailable();
    res.json({
      available,
      rtspUrl: available ? 'rtsp://192.168.42.1:554/live' : null
    });
  } catch (error) {
    console.error('Error checking camera status:', error);
    res.status(500).json({ error: 'Failed to check camera status' });
  }
});

// Get all recordings (for admin page)
app.get('/api/recordings', (req, res) => {
  try {
    const recordings = camera.getAllRecordings();
    res.json(recordings);
  } catch (error) {
    console.error('Error getting recordings:', error);
    res.status(500).json({ error: 'Failed to get recordings' });
  }
});

// Get recordings for a specific serial number
app.get('/api/recordings/:serialNumber/:stationId', (req, res) => {
  try {
    const { serialNumber, stationId } = req.params;
    const recordings = camera.listRecordings(serialNumber, stationId);
    res.json(recordings);
  } catch (error) {
    console.error('Error getting recordings:', error);
    res.status(500).json({ error: 'Failed to get recordings' });
  }
});

// Camera snapshot endpoint - captures a single frame from RTSP
app.get('/api/camera/snapshot', async (req, res) => {
  try {
    const available = await camera.isCameraAvailable();
    if (!available) {
      return res.status(503).json({ error: 'Camera not available' });
    }

    const { spawn } = require('child_process');
    const rtspUrl = 'rtsp://admin:admin@192.168.42.1:554/live';

    // Capture a single frame using ffmpeg
    const ffmpeg = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-f', 'mjpeg',
      '-q:v', '5',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let imageData = [];

    ffmpeg.stdout.on('data', (chunk) => {
      imageData.push(chunk);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && imageData.length > 0) {
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(Buffer.concat(imageData));
      } else {
        res.status(500).json({ error: 'Failed to capture frame' });
      }
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg snapshot error:', err);
      res.status(500).json({ error: 'Failed to capture frame' });
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGKILL');
    }, 5000);

  } catch (error) {
    console.error('Error capturing snapshot:', error);
    res.status(500).json({ error: 'Failed to capture snapshot' });
  }
});

// Camera live view page
app.get('/camera-view', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Camera Live View</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1f2937;
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    header {
      background: #111827;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { font-size: 18px; }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .status-dot.error { background: #ef4444; animation: none; }
    main {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }
    .camera-container {
      max-width: 100%;
      max-height: 80vh;
      position: relative;
    }
    #camera-feed {
      max-width: 100%;
      max-height: 75vh;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .error-message {
      text-align: center;
      padding: 48px;
      color: #9ca3af;
    }
    .controls {
      background: #111827;
      padding: 12px 24px;
      display: flex;
      justify-content: center;
      gap: 16px;
    }
    .controls button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .controls button:hover { background: #2563eb; }
    .controls button:disabled { background: #6b7280; cursor: not-allowed; }
    .fps-display { color: #9ca3af; font-size: 12px; align-self: center; }
  </style>
</head>
<body>
  <header>
    <h1>Camera Live View</h1>
    <div class="status">
      <span id="status-dot" class="status-dot"></span>
      <span id="status-text">Connecting...</span>
    </div>
  </header>
  <main>
    <div class="camera-container">
      <img id="camera-feed" alt="Camera Feed" />
      <div id="error-message" class="error-message" style="display: none;">
        <p>Camera feed unavailable</p>
        <p style="font-size: 14px; margin-top: 8px;">Check camera connection</p>
      </div>
    </div>
  </main>
  <div class="controls">
    <button id="pause-btn" onclick="togglePause()">Pause</button>
    <button onclick="captureSnapshot()">Save Snapshot</button>
    <span class="fps-display">Refresh: <span id="fps">--</span> fps</span>
  </div>
  <script>
    let isPaused = false;
    let frameCount = 0;
    let lastFpsUpdate = Date.now();
    let refreshInterval = null;
    const feedImg = document.getElementById('camera-feed');
    const errorDiv = document.getElementById('error-message');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    function updateFrame() {
      if (isPaused) return;
      const img = new Image();
      img.onload = function() {
        feedImg.src = this.src;
        feedImg.style.display = 'block';
        errorDiv.style.display = 'none';
        statusDot.classList.remove('error');
        statusText.textContent = 'Live';
        frameCount++;
        updateFps();
      };
      img.onerror = function() {
        feedImg.style.display = 'none';
        errorDiv.style.display = 'block';
        statusDot.classList.add('error');
        statusText.textContent = 'Disconnected';
      };
      img.src = '/api/camera/snapshot?t=' + Date.now();
    }

    function updateFps() {
      const now = Date.now();
      const elapsed = (now - lastFpsUpdate) / 1000;
      if (elapsed >= 1) {
        const fps = (frameCount / elapsed).toFixed(1);
        document.getElementById('fps').textContent = fps;
        frameCount = 0;
        lastFpsUpdate = now;
      }
    }

    function togglePause() {
      isPaused = !isPaused;
      document.getElementById('pause-btn').textContent = isPaused ? 'Resume' : 'Pause';
      if (!isPaused) updateFrame();
    }

    function captureSnapshot() {
      const link = document.createElement('a');
      link.href = feedImg.src;
      link.download = 'camera_snapshot_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
      link.click();
    }

    // Start refreshing frames
    updateFrame();
    refreshInterval = setInterval(updateFrame, 500); // 2 fps refresh rate
  </script>
</body>
</html>
  `);
});

// ============ GCS Upload API Routes ============

// Get list of files available for upload
app.get('/api/upload/files', (req, res) => {
  try {
    const files = gcsUploader.getAllUploadableFiles();
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    res.json({
      files,
      count: files.length,
      totalSize,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    });
  } catch (error) {
    console.error('Error getting uploadable files:', error);
    res.status(500).json({ error: 'Failed to get files' });
  }
});

// Start upload of all files
app.post('/api/upload/start', async (req, res) => {
  try {
    const uploadId = gcsUploader.generateUploadId();
    const bucket = req.body.bucket || gcsUploader.DEFAULT_BUCKET;

    // Start upload in background
    gcsUploader.uploadAllFiles(uploadId, bucket).then(result => {
      console.log(`Upload ${uploadId} completed:`, result);
    }).catch(err => {
      console.error(`Upload ${uploadId} failed:`, err);
    });

    res.json({
      success: true,
      uploadId,
      message: 'Upload started',
      bucket
    });
  } catch (error) {
    console.error('Error starting upload:', error);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Get upload progress
app.get('/api/upload/progress/:uploadId', (req, res) => {
  try {
    const { uploadId } = req.params;
    const progress = gcsUploader.getUploadProgress(uploadId);

    if (!progress) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    res.json({
      uploadId,
      ...progress,
      percentComplete: progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
    });
  } catch (error) {
    console.error('Error getting upload progress:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

app.listen(PORT, async () => {
  console.log(`Assembly Instructions Server running on http://localhost:${PORT}`);
  console.log(`Available Stations:`);
  Object.values(STATIONS).forEach(s => {
    console.log(`  - ${s.station_id}: ${s.station_name}`);
  });

  // Check camera status
  const cameraAvailable = await camera.isCameraAvailable();
  console.log(`Camera Status: ${cameraAvailable ? 'Connected (rtsp://192.168.42.1:554/live)' : 'Not available'}`);
});
