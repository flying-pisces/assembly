const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sessionsFile = path.join(dataDir, 'sessions.json');
const pageVisitsFile = path.join(dataDir, 'page_visits.json');
const navigationLogFile = path.join(dataDir, 'navigation_log.json');
const pageTimeSummaryFile = path.join(dataDir, 'page_time_summary.json');

// Ensure data directory exists
function initializeDatabase() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Initialize empty JSON files if they don't exist
  const files = [sessionsFile, pageVisitsFile, navigationLogFile, pageTimeSummaryFile];
  files.forEach(file => {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '[]', 'utf8');
    }
  });

  console.log('Database initialized successfully');
}

// Helper functions to read/write JSON files
function readJson(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Generate unique ID
let idCounter = Date.now();
function generateId() {
  return ++idCounter;
}

// Create a new assembly session with station info
function createSession(sessionId, serialNumber, stationId, stationName, documentName, totalPages) {
  const sessions = readJson(sessionsFile);
  const now = Date.now();
  const newSession = {
    id: generateId(),
    session_id: sessionId,
    serial_number: serialNumber,
    station_id: stationId,
    station_name: stationName,
    document_name: documentName,
    total_pages: totalPages,
    start_time: now,
    start_time_iso: new Date(now).toISOString(),
    end_time: null,
    end_time_iso: null,
    total_duration_seconds: null,
    status: 'in_progress',
    created_at: now,
    created_at_iso: new Date(now).toISOString()
  };
  sessions.push(newSession);
  writeJson(sessionsFile, sessions);
  return sessionId;
}

// End an assembly session
function endSession(sessionId) {
  const sessions = readJson(sessionsFile);
  const sessionIndex = sessions.findIndex(s => s.session_id === sessionId);

  if (sessionIndex !== -1) {
    const now = Date.now();
    const startTime = sessions[sessionIndex].start_time;
    sessions[sessionIndex].end_time = now;
    sessions[sessionIndex].end_time_iso = new Date(now).toISOString();
    sessions[sessionIndex].total_duration_seconds = (now - startTime) / 1000;
    sessions[sessionIndex].status = 'completed';
    writeJson(sessionsFile, sessions);
  }
}

// Record page entry
function recordPageEntry(sessionId, pageNumber, visitSequence, navigationDirection) {
  const visits = readJson(pageVisitsFile);
  const now = Date.now();
  const newVisit = {
    id: generateId(),
    session_id: sessionId,
    page_number: pageNumber,
    visit_sequence: visitSequence,
    entry_time: now,
    entry_time_iso: new Date(now).toISOString(),
    exit_time: null,
    exit_time_iso: null,
    duration_seconds: null,
    navigation_direction: navigationDirection,
    created_at: now
  };
  visits.push(newVisit);
  writeJson(pageVisitsFile, visits);
  return newVisit.id;
}

// Record page exit and calculate duration
function recordPageExit(visitId) {
  const visits = readJson(pageVisitsFile);
  const visitIndex = visits.findIndex(v => v.id === visitId);

  if (visitIndex !== -1) {
    const now = Date.now();
    const entryTime = visits[visitIndex].entry_time;
    visits[visitIndex].exit_time = now;
    visits[visitIndex].exit_time_iso = new Date(now).toISOString();
    visits[visitIndex].duration_seconds = (now - entryTime) / 1000;
    writeJson(pageVisitsFile, visits);
    return { duration_seconds: visits[visitIndex].duration_seconds };
  }
  return null;
}

// Log navigation action
function logNavigation(sessionId, fromPage, toPage, action, timeOnPreviousPage, cumulativeTime) {
  const logs = readJson(navigationLogFile);
  const now = Date.now();
  const newLog = {
    id: generateId(),
    session_id: sessionId,
    from_page: fromPage,
    to_page: toPage,
    action: action,
    timestamp: now,
    timestamp_iso: new Date(now).toISOString(),
    time_on_previous_page_seconds: timeOnPreviousPage,
    cumulative_time_seconds: cumulativeTime,
    created_at: now
  };
  logs.push(newLog);
  writeJson(navigationLogFile, logs);
}

// Update page time summary
function updatePageTimeSummary(sessionId, pageNumber, durationSeconds) {
  const summaries = readJson(pageTimeSummaryFile);
  const now = Date.now();
  const existingIndex = summaries.findIndex(
    s => s.session_id === sessionId && s.page_number === pageNumber
  );

  if (existingIndex !== -1) {
    summaries[existingIndex].total_time_seconds += durationSeconds;
    summaries[existingIndex].visit_count += 1;
    summaries[existingIndex].last_visit_time = now;
    summaries[existingIndex].last_visit_time_iso = new Date(now).toISOString();
  } else {
    summaries.push({
      id: generateId(),
      session_id: sessionId,
      page_number: pageNumber,
      total_time_seconds: durationSeconds,
      visit_count: 1,
      first_visit_time: now,
      first_visit_time_iso: new Date(now).toISOString(),
      last_visit_time: now,
      last_visit_time_iso: new Date(now).toISOString()
    });
  }
  writeJson(pageTimeSummaryFile, summaries);
}

// Get session details
function getSession(sessionId) {
  const sessions = readJson(sessionsFile);
  return sessions.find(s => s.session_id === sessionId);
}

// Get all page visits for a session
function getPageVisits(sessionId) {
  const visits = readJson(pageVisitsFile);
  return visits
    .filter(v => v.session_id === sessionId)
    .sort((a, b) => a.visit_sequence - b.visit_sequence);
}

// Get navigation log for a session
function getNavigationLog(sessionId) {
  const logs = readJson(navigationLogFile);
  return logs
    .filter(l => l.session_id === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Get page time summary for a session
function getPageTimeSummary(sessionId) {
  const summaries = readJson(pageTimeSummaryFile);
  return summaries
    .filter(s => s.session_id === sessionId)
    .sort((a, b) => a.page_number - b.page_number);
}

// Get session summary with all details
function getSessionSummary(sessionId) {
  const session = getSession(sessionId);
  const pageVisits = getPageVisits(sessionId);
  const navigationLog = getNavigationLog(sessionId);
  const pageTimeSummary = getPageTimeSummary(sessionId);

  return {
    session,
    pageVisits,
    navigationLog,
    pageTimeSummary
  };
}

// Get all sessions
function getAllSessions() {
  const sessions = readJson(sessionsFile);
  return sessions.sort((a, b) => b.created_at - a.created_at);
}

// Get sessions by station
function getSessionsByStation(stationId) {
  const sessions = readJson(sessionsFile);
  return sessions
    .filter(s => s.station_id === stationId)
    .sort((a, b) => b.created_at - a.created_at);
}

// Get sessions by serial number
function getSessionsBySerialNumber(serialNumber) {
  const sessions = readJson(sessionsFile);
  return sessions
    .filter(s => s.serial_number === serialNumber)
    .sort((a, b) => b.created_at - a.created_at);
}

// Check if serial number exists (legacy - checks all stations)
function serialNumberExists(serialNumber) {
  const sessions = readJson(sessionsFile);
  return sessions.some(
    s => s.serial_number === serialNumber && s.status === 'completed'
  );
}

// Check if serial number exists for a specific station
function serialNumberExistsForStation(serialNumber, stationId) {
  const sessions = readJson(sessionsFile);
  return sessions.some(
    s => s.serial_number === serialNumber &&
        s.station_id === stationId &&
        s.status === 'completed'
  );
}

// Clear all database records (used after successful upload to GCS)
function clearDatabase() {
  const files = [sessionsFile, pageVisitsFile, navigationLogFile, pageTimeSummaryFile];
  files.forEach(file => {
    writeJson(file, []);
  });
  console.log('Database cleared successfully');
  return { success: true, message: 'All records cleared' };
}

module.exports = {
  initializeDatabase,
  createSession,
  endSession,
  recordPageEntry,
  recordPageExit,
  logNavigation,
  updatePageTimeSummary,
  getSession,
  getPageVisits,
  getNavigationLog,
  getPageTimeSummary,
  getSessionSummary,
  getAllSessions,
  getSessionsByStation,
  getSessionsBySerialNumber,
  serialNumberExists,
  serialNumberExistsForStation,
  clearDatabase
};
