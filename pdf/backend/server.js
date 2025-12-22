const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/pages', express.static(path.join(__dirname, '..', 'public', 'pages')));
app.use('/pdf', express.static(path.join(__dirname, '..')));

// Initialize database
db.initializeDatabase();

// Document configuration
const DOCUMENT_CONFIG = {
  name: '[M-2007091] Left Hip Mechanical Assembly (DELTA)',
  totalPages: 40,
  pdfFile: '[M-2007091] Left Hip Mechanical Assembly (DELTA).pdf'
};

// API Routes

// Get document info
app.get('/api/document', (req, res) => {
  res.json(DOCUMENT_CONFIG);
});

// Start a new assembly session
app.post('/api/session/start', (req, res) => {
  try {
    const { serialNumber } = req.body;

    if (!serialNumber) {
      return res.status(400).json({ error: 'Serial number is required' });
    }

    // Check if serial number was already used for a completed assembly
    if (db.serialNumberExists(serialNumber)) {
      return res.status(400).json({
        error: 'Serial number already used',
        message: 'This serial number has already been used for a completed assembly'
      });
    }

    const sessionId = uuidv4();
    db.createSession(sessionId, serialNumber, DOCUMENT_CONFIG.name, DOCUMENT_CONFIG.totalPages);

    res.json({
      success: true,
      sessionId,
      serialNumber,
      documentName: DOCUMENT_CONFIG.name,
      totalPages: DOCUMENT_CONFIG.totalPages
    });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// End assembly session
app.post('/api/session/:sessionId/end', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { finalPageVisitId } = req.body;

    // Record exit from final page if provided
    if (finalPageVisitId) {
      const exitResult = db.recordPageExit(finalPageVisitId);
      if (exitResult && exitResult.duration_seconds) {
        // Get current page from the visit
        const session = db.getSession(sessionId);
        if (session) {
          // Update summary would need the page number - handled by frontend
        }
      }
    }

    db.endSession(sessionId);
    const summary = db.getSessionSummary(sessionId);

    res.json({
      success: true,
      summary
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
app.post('/api/session/:sessionId/page/exit', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { visitId, pageNumber, durationSeconds } = req.body;

    if (visitId) {
      db.recordPageExit(visitId);
    }

    if (pageNumber !== undefined && durationSeconds !== undefined) {
      db.updatePageTimeSummary(sessionId, pageNumber, durationSeconds);
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

// Get all sessions
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.getAllSessions();
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

app.listen(PORT, () => {
  console.log(`Assembly Instructions Server running on http://localhost:${PORT}`);
  console.log(`Document: ${DOCUMENT_CONFIG.name}`);
  console.log(`Total Pages: ${DOCUMENT_CONFIG.totalPages}`);
});
