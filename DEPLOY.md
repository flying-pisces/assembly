# Assembly Instructions Viewer - Deployment Guide

## Quick Deployment (Recommended)

### Option 1: Using the Package (No Docker)

1. **Create the package** (on source machine):
   ```bash
   ./create-package.sh
   ```

2. **Copy to target machine**:
   ```bash
   scp assembly-viewer-YYYYMMDD.tar.gz user@target-machine:~
   ```

3. **On target machine** (Ubuntu 22.04):
   ```bash
   tar -xzvf assembly-viewer-YYYYMMDD.tar.gz
   cd assembly-viewer-YYYYMMDD
   ./setup.sh
   ./start.sh
   ```

### Option 2: Using Docker

1. **Install Docker on target machine**:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # Log out and back in
   ```

2. **Copy project to target machine** and run:
   ```bash
   docker-compose up -d
   ```

## Manual Installation

### Prerequisites (Ubuntu 22.04)

```bash
# Update system
sudo apt-get update

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install FFmpeg and other dependencies
sudo apt-get install -y ffmpeg python3 python3-pip v4l-utils

# Install Python GCS library (for cloud upload)
pip3 install google-cloud-storage
```

### Install Application

```bash
# Clone or copy the project
cd /home/$USER/projects
# git clone <repo> assembly
# OR extract from tarball

# Install Node dependencies
cd assembly/src
npm install

# Create data directories
mkdir -p ../recordings
mkdir -p data

# Initialize data files
echo '[]' > data/sessions.json
echo '[]' > data/page_visits.json
echo '[]' > data/navigation_log.json
echo '[]' > data/page_time_summary.json
```

### Run the Application

```bash
# Start manually
node backend/server.js

# Or use the start script
./start.sh
```

### Run as System Service

```bash
# Copy service file
sudo cp assembly-viewer.service /etc/systemd/system/

# Edit the service file to match your username and paths
sudo nano /etc/systemd/system/assembly-viewer.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable assembly-viewer
sudo systemctl start assembly-viewer

# Check status
sudo systemctl status assembly-viewer
```

## Camera Setup

### reCamera (RTSP - Primary)
- Connect reCamera to the network
- Default IP: 192.168.42.1
- RTSP URL: rtsp://admin:admin@192.168.42.1:554/live
- Web interface: http://192.168.42.1/

### Logitech USB Camera (Fallback)
- Connect via USB
- Should appear as /dev/video0
- Add user to video group: `sudo usermod -aG video $USER`

## GCS Upload Setup

1. Place your GCS service account JSON in `upload/upload.json`
2. Ensure the service account has `storage.objects.create` permission

## Access Points

- **Main Application**: http://localhost:3000
- **Admin Dashboard**: http://localhost:3000/admin
- **Camera View**: http://localhost:3000/camera-view

## Troubleshooting

### Camera not detected
```bash
# Check USB devices
lsusb | grep -i camera

# Check video devices
ls -la /dev/video*

# Check reCamera connectivity
ping 192.168.42.1
nc -zv 192.168.42.1 554
```

### Server won't start
```bash
# Check if port 3000 is in use
sudo lsof -i :3000

# Check Node.js version
node -v  # Should be 18+

# Check logs
journalctl -u assembly-viewer -f
```
