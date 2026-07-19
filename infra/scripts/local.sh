#!/bin/bash
set -e

# Local development script for AINX Lambda functions
# Usage: ./local.sh [function-name]

FUNCTION_NAME=${1:-hello-world}

echo "🚀 Starting local development for: $FUNCTION_NAME"

# Check if function exists
if [ ! -d "functions/$FUNCTION_NAME" ]; then
  echo "❌ Function not found: $FUNCTION_NAME"
  echo "Available functions:"
  ls -1 functions/
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo " Installing dependencies..."
  npm install
fi

# Build and watch for changes
echo "👀 Watching for changes..."
cd "functions/$FUNCTION_NAME"
npm run build:watch
