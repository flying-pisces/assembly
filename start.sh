#!/bin/bash
# Start the Assembly Instructions Viewer server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting Assembly Instructions Viewer..."
echo "Access at: http://localhost:3000"
echo "Admin at:  http://localhost:3000/admin"
echo ""
echo "Press Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR/src"
node backend/server.js
