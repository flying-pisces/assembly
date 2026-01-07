// Assembly Instructions Viewer Application
class AssemblyViewer {
  constructor() {
    // State
    this.stations = [];
    this.selectedStation = null;
    this.sessionId = null;
    this.serialNumber = null;
    this.currentPage = 1;
    this.totalPages = null;
    this.visitSequence = 0;
    this.currentVisitId = null;

    // Timing
    this.sessionStartTime = null;
    this.pageStartTime = null;
    this.pageTimes = {}; // Store cumulative time per page
    this.totalElapsedSeconds = 0;

    // PDF.js
    this.pdfDoc = null;
    this.pdfPath = null;

    // Timers
    this.pageTimerInterval = null;
    this.totalTimerInterval = null;

    // DOM Elements
    this.screens = {
      station: document.getElementById('station-screen'),
      sn: document.getElementById('sn-screen'),
      viewer: document.getElementById('viewer-screen'),
      complete: document.getElementById('complete-screen')
    };

    this.elements = {
      stationList: document.getElementById('station-list'),
      selectedStationName: document.getElementById('selected-station-name'),
      documentTitle: document.getElementById('document-title'),
      stationIdDisplay: document.getElementById('station-id-display'),
      backToStations: document.getElementById('back-to-stations'),
      serialInput: document.getElementById('serial-number'),
      startBtn: document.getElementById('start-btn'),
      snError: document.getElementById('sn-error'),
      viewerStationId: document.getElementById('viewer-station-id'),
      viewerDocTitle: document.getElementById('viewer-doc-title'),
      currentSn: document.getElementById('current-sn'),
      currentPage: document.getElementById('current-page'),
      totalPagesEl: document.getElementById('total-pages'),
      pageTimer: document.getElementById('page-timer'),
      totalTimer: document.getElementById('total-timer'),
      prevBtn: document.getElementById('prev-btn'),
      nextBtn: document.getElementById('next-btn'),
      pdfCanvas: document.getElementById('pdf-canvas'),
      progressFill: document.getElementById('progress-fill'),
      completeBtn: document.getElementById('complete-btn'),
      completeStation: document.getElementById('complete-station'),
      completeSn: document.getElementById('complete-sn'),
      completeTime: document.getElementById('complete-time'),
      completePages: document.getElementById('complete-pages'),
      pageTimeSummary: document.getElementById('page-time-summary'),
      newAssemblyBtn: document.getElementById('new-assembly-btn')
    };

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.loadStations();
  }

  bindEvents() {
    // Back to stations button
    this.elements.backToStations.addEventListener('click', () => {
      this.showScreen('station');
    });

    // Serial number input
    this.elements.serialInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.startSession();
      }
    });

    this.elements.startBtn.addEventListener('click', () => this.startSession());

    // Navigation
    this.elements.prevBtn.addEventListener('click', () => this.navigatePage('prev'));
    this.elements.nextBtn.addEventListener('click', () => this.navigatePage('next'));

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (this.screens.viewer.classList.contains('active')) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          this.navigatePage('prev');
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
          e.preventDefault();
          this.navigatePage('next');
        }
      }
    });

    // Complete assembly
    this.elements.completeBtn.addEventListener('click', () => this.completeAssembly());

    // New assembly
    this.elements.newAssemblyBtn.addEventListener('click', () => this.resetToStart());

    // Handle page visibility change (pause timing when tab is hidden)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.sessionId) {
        // Page is hidden, record the time
        this.recordPageTime();
      } else if (!document.hidden && this.sessionId) {
        // Page is visible again, restart page timer
        this.pageStartTime = Date.now();
      }
    });

    // Handle window beforeunload
    window.addEventListener('beforeunload', (e) => {
      if (this.sessionId && this.screens.viewer.classList.contains('active')) {
        this.recordPageTime();
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  async loadStations() {
    try {
      const response = await fetch('/api/stations');
      this.stations = await response.json();
      this.renderStations();
    } catch (error) {
      console.error('Error loading stations:', error);
    }
  }

  renderStations() {
    this.elements.stationList.innerHTML = this.stations.map(station => `
      <div class="station-card" data-station-id="${station.station_id}">
        <span class="station-id">${station.station_id}</span>
        <div class="station-name">${station.station_name}</div>
        <div class="station-doc">${station.document_name}</div>
      </div>
    `).join('');

    // Add click handlers
    this.elements.stationList.querySelectorAll('.station-card').forEach(card => {
      card.addEventListener('click', () => {
        const stationId = card.dataset.stationId;
        this.selectStation(stationId);
      });
    });
  }

  async selectStation(stationId) {
    const station = this.stations.find(s => s.station_id === stationId);
    if (!station) return;

    this.selectedStation = station;

    // Update SN screen with station info
    this.elements.selectedStationName.textContent = station.station_name;
    this.elements.documentTitle.textContent = station.station_name;
    this.elements.stationIdDisplay.textContent = station.station_id;

    // Load document info for this station
    await this.loadDocument(stationId);

    this.showScreen('sn');
    this.elements.serialInput.focus();
  }

  async loadDocument(stationId) {
    try {
      const response = await fetch(`/api/document?station=${stationId}`);
      const doc = await response.json();

      this.totalPages = doc.totalPages;
      this.pdfPath = `/pdf/${doc.pdfFile}`;

      // Load PDF
      await this.loadPDF();
    } catch (error) {
      console.error('Error loading document:', error);
    }
  }

  async loadPDF() {
    try {
      this.pdfDoc = await pdfjsLib.getDocument(this.pdfPath).promise;
      this.totalPages = this.pdfDoc.numPages;
      this.elements.totalPagesEl.textContent = this.totalPages;
      console.log('PDF loaded successfully:', this.totalPages, 'pages');
      // Update UI to enable/disable navigation buttons based on actual page count
      this.updateUI();
    } catch (error) {
      console.error('Error loading PDF:', error);
    }
  }

  async renderPage(pageNum) {
    if (!this.pdfDoc) {
      console.error('PDF not loaded');
      return;
    }

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const canvas = this.elements.pdfCanvas;
      const ctx = canvas.getContext('2d');

      // Calculate scale to fit the viewport
      const containerHeight = window.innerHeight - 120 - 60 - 40; // header, footer, padding
      const containerWidth = window.innerWidth - 140 - 40; // nav arrows, padding

      const viewport = page.getViewport({ scale: 1 });
      const scaleHeight = containerHeight / viewport.height;
      const scaleWidth = containerWidth / viewport.width;
      const scale = Math.min(scaleHeight, scaleWidth, 1.5); // Cap at 1.5x

      const scaledViewport = page.getViewport({ scale });

      canvas.height = scaledViewport.height;
      canvas.width = scaledViewport.width;

      const renderContext = {
        canvasContext: ctx,
        viewport: scaledViewport
      };

      await page.render(renderContext).promise;
    } catch (error) {
      console.error('Error rendering page:', error);
    }
  }

  showScreen(screenName) {
    Object.values(this.screens).forEach(screen => screen.classList.remove('active'));
    this.screens[screenName].classList.add('active');
  }

  async startSession() {
    const serialNumber = this.elements.serialInput.value.trim();

    if (!serialNumber) {
      this.elements.snError.textContent = 'Please enter a serial number';
      return;
    }

    if (!this.selectedStation) {
      this.elements.snError.textContent = 'Please select a station first';
      return;
    }

    try {
      const response = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serialNumber,
          stationId: this.selectedStation.station_id
        })
      });

      const data = await response.json();

      if (!response.ok) {
        this.elements.snError.textContent = data.message || data.error;
        return;
      }

      // Initialize session
      this.sessionId = data.sessionId;
      this.serialNumber = serialNumber;
      // Use server's totalPages if provided, otherwise keep PDF.js detected value
      if (data.totalPages && data.totalPages > 0) {
        this.totalPages = data.totalPages;
      }
      // If still not set, it will be set when PDF loads in loadPDF()
      this.currentPage = 1;
      this.visitSequence = 0;
      this.pageTimes = {};

      // Update UI
      this.elements.viewerStationId.textContent = data.stationId;
      this.elements.viewerDocTitle.textContent = data.stationName;
      this.elements.currentSn.textContent = serialNumber;
      this.elements.totalPagesEl.textContent = this.totalPages || '-';
      this.elements.snError.textContent = '';

      // Start timing
      this.sessionStartTime = Date.now();
      this.startTotalTimer();

      // Show viewer and render first page
      this.showScreen('viewer');
      await this.goToPage(1, 'start');

    } catch (error) {
      console.error('Error starting session:', error);
      this.elements.snError.textContent = 'Failed to start session. Please try again.';
    }
  }

  async goToPage(pageNum, direction = 'forward') {
    // Don't go below page 1, and don't exceed totalPages (if known)
    if (pageNum < 1 || (this.totalPages && pageNum > this.totalPages)) return;

    // Record time on previous page
    if (this.currentVisitId) {
      await this.recordPageTime();
    }

    // Update state
    const fromPage = this.currentPage;
    this.currentPage = pageNum;
    this.visitSequence++;

    // Record page entry
    await this.recordPageEntry(pageNum, direction);

    // Log navigation
    const timeOnPrevPage = this.pageTimes[fromPage] || 0;
    await this.logNavigation(fromPage, pageNum, direction, timeOnPrevPage);

    // Render page
    await this.renderPage(pageNum);

    // Update UI
    this.updateUI();

    // Start page timer
    this.pageStartTime = Date.now();
    this.startPageTimer();
  }

  async recordPageEntry(pageNum, direction) {
    try {
      const response = await fetch(`/api/session/${this.sessionId}/page/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageNumber: pageNum,
          visitSequence: this.visitSequence,
          navigationDirection: direction
        })
      });

      const data = await response.json();
      this.currentVisitId = data.visitId;
    } catch (error) {
      console.error('Error recording page entry:', error);
    }
  }

  async recordPageTime() {
    if (!this.pageStartTime) return;

    const duration = (Date.now() - this.pageStartTime) / 1000;

    // Update local page times
    if (!this.pageTimes[this.currentPage]) {
      this.pageTimes[this.currentPage] = 0;
    }
    this.pageTimes[this.currentPage] += duration;

    try {
      await fetch(`/api/session/${this.sessionId}/page/exit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitId: this.currentVisitId,
          pageNumber: this.currentPage,
          durationSeconds: duration
        })
      });
    } catch (error) {
      console.error('Error recording page exit:', error);
    }

    this.pageStartTime = null;
  }

  async logNavigation(fromPage, toPage, action, timeOnPrevPage) {
    const cumulativeTime = (Date.now() - this.sessionStartTime) / 1000;

    try {
      await fetch(`/api/session/${this.sessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromPage,
          toPage,
          action,
          timeOnPreviousPage: timeOnPrevPage,
          cumulativeTime
        })
      });
    } catch (error) {
      console.error('Error logging navigation:', error);
    }
  }

  navigatePage(direction) {
    if (direction === 'prev' && this.currentPage > 1) {
      this.goToPage(this.currentPage - 1, 'backward');
    } else if (direction === 'next' && (!this.totalPages || this.currentPage < this.totalPages)) {
      this.goToPage(this.currentPage + 1, 'forward');
    }
  }

  updateUI() {
    // Update page number
    this.elements.currentPage.textContent = this.currentPage;
    this.elements.totalPagesEl.textContent = this.totalPages || '-';

    // Update navigation buttons
    this.elements.prevBtn.disabled = this.currentPage <= 1;
    // Only disable next if we know the total and we're at the last page
    this.elements.nextBtn.disabled = this.totalPages && this.currentPage >= this.totalPages;

    // Update progress bar
    const progress = this.totalPages ? (this.currentPage / this.totalPages) * 100 : 0;
    this.elements.progressFill.style.width = `${progress}%`;

    // Show/hide complete button on last page
    this.elements.completeBtn.style.display = (this.totalPages && this.currentPage === this.totalPages) ? 'block' : 'none';
  }

  startPageTimer() {
    // Clear existing interval
    if (this.pageTimerInterval) {
      clearInterval(this.pageTimerInterval);
    }

    // Reset display
    this.elements.pageTimer.textContent = '00:00';

    this.pageTimerInterval = setInterval(() => {
      if (this.pageStartTime) {
        const elapsed = Math.floor((Date.now() - this.pageStartTime) / 1000);
        this.elements.pageTimer.textContent = this.formatTime(elapsed);
      }
    }, 1000);
  }

  startTotalTimer() {
    if (this.totalTimerInterval) {
      clearInterval(this.totalTimerInterval);
    }

    this.totalTimerInterval = setInterval(() => {
      if (this.sessionStartTime) {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        this.elements.totalTimer.textContent = this.formatTime(elapsed, true);
      }
    }, 1000);
  }

  formatTime(seconds, includeHours = false) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (includeHours || hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  async completeAssembly() {
    // Record final page time
    await this.recordPageTime();

    // Log completion navigation
    await this.logNavigation(this.currentPage, null, 'complete', this.pageTimes[this.currentPage] || 0);

    try {
      const response = await fetch(`/api/session/${this.sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finalPageVisitId: this.currentVisitId,
          finalPage: this.currentPage
        })
      });

      const data = await response.json();

      // Stop timers
      clearInterval(this.pageTimerInterval);
      clearInterval(this.totalTimerInterval);

      // Show completion screen
      this.showCompletionScreen(data.summary);

    } catch (error) {
      console.error('Error completing assembly:', error);
      alert('Failed to complete assembly. Please try again.');
    }
  }

  showCompletionScreen(summary) {
    // Update completion details
    this.elements.completeStation.textContent = `${this.selectedStation.station_id} - ${this.selectedStation.station_name}`;
    this.elements.completeSn.textContent = this.serialNumber;

    const totalSeconds = summary.session.total_duration_seconds ||
      Math.floor((Date.now() - this.sessionStartTime) / 1000);
    this.elements.completeTime.textContent = this.formatTime(Math.floor(totalSeconds), true);

    // Count unique pages viewed
    const uniquePages = new Set(summary.pageVisits.map(v => v.page_number)).size;
    this.elements.completePages.textContent = `${uniquePages} / ${this.totalPages}`;

    // Build page time summary
    this.elements.pageTimeSummary.innerHTML = '';

    // Combine local and server page times
    const pageTimeData = {};

    // Use local times as primary source
    for (const [page, time] of Object.entries(this.pageTimes)) {
      pageTimeData[page] = time;
    }

    // Add any server times not in local
    if (summary.pageTimeSummary) {
      for (const item of summary.pageTimeSummary) {
        if (!pageTimeData[item.page_number]) {
          pageTimeData[item.page_number] = item.total_time_seconds;
        }
      }
    }

    // Create page time grid
    for (let i = 1; i <= this.totalPages; i++) {
      const time = pageTimeData[i] || 0;
      const item = document.createElement('div');
      item.className = 'page-time-item';
      item.innerHTML = `
        <span class="page-num">Page ${i}</span>
        <span class="page-time">${this.formatTime(Math.floor(time))}</span>
      `;
      this.elements.pageTimeSummary.appendChild(item);
    }

    this.showScreen('complete');
  }

  resetToStart() {
    // Reset state
    this.sessionId = null;
    this.serialNumber = null;
    this.currentPage = 1;
    this.visitSequence = 0;
    this.currentVisitId = null;
    this.sessionStartTime = null;
    this.pageStartTime = null;
    this.pageTimes = {};
    this.pdfDoc = null;

    // Clear timers
    if (this.pageTimerInterval) clearInterval(this.pageTimerInterval);
    if (this.totalTimerInterval) clearInterval(this.totalTimerInterval);

    // Reset UI
    this.elements.serialInput.value = '';
    this.elements.snError.textContent = '';
    this.elements.pageTimer.textContent = '00:00';
    this.elements.totalTimer.textContent = '00:00:00';
    this.elements.progressFill.style.width = '2.5%';
    this.elements.completeBtn.style.display = 'none';

    // Show station screen
    this.selectedStation = null;
    this.showScreen('station');
  }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  window.app = new AssemblyViewer();
});
