#!/bin/bash
# Assembly Instructions Viewer - Setup Script for Ubuntu 22.04
# Run this script on a fresh Ubuntu 22.04 machine to set up the application

set -e

echo "=========================================="
echo "Assembly Instructions Viewer Setup Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Warning: Running as root. Consider running as a regular user.${NC}"
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"

echo -e "${GREEN}[1/6] Updating system packages...${NC}"
sudo apt-get update

echo -e "${GREEN}[2/6] Installing system dependencies...${NC}"
sudo apt-get install -y \
    curl \
    gnupg \
    ffmpeg \
    python3 \
    python3-pip \
    net-tools \
    v4l-utils \
    git

echo -e "${GREEN}[3/6] Installing Node.js 20.x...${NC}"
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 18 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js already installed: $(node -v)"
fi

echo -e "${GREEN}[4/6] Installing Python dependencies for GCS upload...${NC}"
pip3 install --user google-cloud-storage

echo -e "${GREEN}[5/6] Installing Node.js dependencies...${NC}"
cd "$APP_DIR/src"
npm install

echo -e "${GREEN}[6/6] Setting up directories and permissions...${NC}"
cd "$APP_DIR"

# Create necessary directories
mkdir -p recordings
mkdir -p src/data

# Initialize empty data files if they don't exist
[ -f src/data/sessions.json ] || echo '[]' > src/data/sessions.json
[ -f src/data/page_visits.json ] || echo '[]' > src/data/page_visits.json
[ -f src/data/navigation_log.json ] || echo '[]' > src/data/navigation_log.json
[ -f src/data/page_time_summary.json ] || echo '[]' > src/data/page_time_summary.json

# Add current user to video group for camera access
sudo usermod -aG video $USER

echo ""
echo -e "${GREEN}=========================================="
echo "Setup Complete!"
echo "==========================================${NC}"
echo ""
echo "To start the server, run:"
echo "  cd $APP_DIR/src"
echo "  node backend/server.js"
echo ""
echo "Or use the start script:"
echo "  $APP_DIR/start.sh"
echo ""
echo "Access the application at:"
echo "  - Main app: http://localhost:3000"
echo "  - Admin:    http://localhost:3000/admin"
echo ""
echo -e "${YELLOW}Note: Log out and back in for video group permissions to take effect.${NC}"
