#!/bin/bash
# Script to safely update the GroupWhats application on Ubuntu server
# Usage: ./update.sh

set -euo pipefail

# Configuration
REPO_DIR="/home/ubuntu/groupwhats"
BRANCH="main"

echo "--- Updating GroupWhats application ---"

# Navigate to repository
cd "$REPO_DIR"

# Ensure we are on the correct branch
git checkout $BRANCH

# Fetch latest changes and reset to remote state (discourages merge conflicts)
git fetch origin
# Reset hard to remote branch to avoid local uncommitted changes
git reset --hard origin/$BRANCH

# Install any new dependencies
npm install

# Restart the application using PM2, updating environment variables
pm2 restart groupwhats --update-env

echo "--- Update completed successfully ---"
