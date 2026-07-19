#!/bin/bash
set -e

# Deploy script for AINX Lambda monorepo
# Usage: ./deploy.sh [stage] [function-name]

STAGE=${1:-dev}
FUNCTION_NAME=$2

echo "🚀 Deploying AINX Lambda functions..."
echo "Stage: $STAGE"

# Validate stage
if [[ ! "$STAGE" =~ ^(dev|staging|prod)$ ]]; then
  echo "❌ Invalid stage. Use: dev, staging, or prod"
  exit 1
fi

# Build all functions or specific function
if [ -z "$FUNCTION_NAME" ]; then
  echo "📦 Building all functions..."
  npm run build --workspaces
else
  echo "📦 Building function: $FUNCTION_NAME"
  npm run build --workspace="functions/$FUNCTION_NAME"
fi

# Deploy using SAM
echo "☁️  Deploying to AWS..."
sam deploy \
  --template-file infra/templates/template.yaml \
  --stack-name "ainx-lambda-$STAGE" \
  --s3-bucket "ainx-lambda-deployments-$STAGE" \
  --region us-east-1 \
  --parameter-overrides "Stage=$STAGE" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset

echo "✅ Deployment complete!"
