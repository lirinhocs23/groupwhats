#!/bin/bash
# post-merge hook: install deps and restart pm2
set -e
cd "$(git rev-parse --show-toplevel)"
# Install/Update npm packages
npm install --silent
# Restart the groupwhats process with updated env
pm2 restart groupwhats --update-env
echo "Post-merge hook executed: npm install and pm2 restart completed."
