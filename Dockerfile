# Assembly Instructions Viewer
# Ubuntu 22.04 based image with Node.js and FFmpeg

FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ffmpeg \
    python3 \
    python3-pip \
    net-tools \
    iputils-ping \
    v4l-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies for GCS upload
RUN pip3 install google-cloud-storage

# Create app directory
WORKDIR /app

# Copy package files first (for better caching)
COPY src/package*.json ./src/

# Install Node.js dependencies
WORKDIR /app/src
RUN npm install

# Copy application files
WORKDIR /app
COPY . .

# Create necessary directories
RUN mkdir -p recordings src/data

# Initialize empty data files if they don't exist
RUN echo '[]' > src/data/sessions.json 2>/dev/null || true \
    && echo '[]' > src/data/page_visits.json 2>/dev/null || true \
    && echo '[]' > src/data/navigation_log.json 2>/dev/null || true \
    && echo '[]' > src/data/page_time_summary.json 2>/dev/null || true

# Expose port
EXPOSE 3000

# Set working directory for running the app
WORKDIR /app/src

# Start the server
CMD ["node", "backend/server.js"]
