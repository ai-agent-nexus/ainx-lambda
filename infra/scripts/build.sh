#!/bin/bash
set -e

# Build script for AINX Lambda functions
# Usage: ./build.sh [function-name]

FUNCTION_NAME=$1

if [ -z "$FUNCTION_NAME" ]; then
  echo "📦 Building all functions..."
  npm run build --workspaces
else
  echo "📦 Building function: $FUNCTION_NAME"
  cd "functions/$FUNCTION_NAME"
  npm run build
fi

echo "✅ Build complete!"
