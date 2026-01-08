#!/bin/bash
# Create a deployable package of the Assembly Instructions Viewer
# This creates a tarball that can be copied to another machine

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="assembly-viewer-$(date +%Y%m%d)"
TEMP_DIR="/tmp/$PACKAGE_NAME"

echo "Creating deployment package..."

# Clean up any existing temp directory
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# Copy application files (excluding unnecessary files)
rsync -av --progress "$SCRIPT_DIR/" "$TEMP_DIR/" \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'recordings/*' \
    --exclude 'src/data/*.json' \
    --exclude '*.log' \
    --exclude 'test.jpg' \
    --exclude '.env' \
    --exclude '__pycache__'

# Create empty data files
mkdir -p "$TEMP_DIR/recordings"
mkdir -p "$TEMP_DIR/src/data"
echo '[]' > "$TEMP_DIR/src/data/sessions.json"
echo '[]' > "$TEMP_DIR/src/data/page_visits.json"
echo '[]' > "$TEMP_DIR/src/data/navigation_log.json"
echo '[]' > "$TEMP_DIR/src/data/page_time_summary.json"

# Make scripts executable
chmod +x "$TEMP_DIR/setup.sh"
chmod +x "$TEMP_DIR/start.sh"
chmod +x "$TEMP_DIR/create-package.sh"

# Create the tarball
cd /tmp
tar -czvf "$SCRIPT_DIR/$PACKAGE_NAME.tar.gz" "$PACKAGE_NAME"

# Clean up
rm -rf "$TEMP_DIR"

echo ""
echo "=========================================="
echo "Package created: $SCRIPT_DIR/$PACKAGE_NAME.tar.gz"
echo "=========================================="
echo ""
echo "To deploy on another Ubuntu 22.04 machine:"
echo "  1. Copy $PACKAGE_NAME.tar.gz to the target machine"
echo "  2. Extract: tar -xzvf $PACKAGE_NAME.tar.gz"
echo "  3. Run setup: cd $PACKAGE_NAME && ./setup.sh"
echo "  4. Start: ./start.sh"
echo ""
