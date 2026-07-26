#!/bin/bash
set -e

# AINX AWS Infrastructure Setup
# 用法: ./scripts/aws-setup.sh <stage>
# 示例: ./scripts/aws-setup.sh sit

STAGE="${1:-sit}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=========================================="
echo "AINX Infrastructure Setup"
echo "Stage: $STAGE"
echo "Region: $AWS_REGION"
echo "Account: $ACCOUNT_ID"
echo "=========================================="
echo ""

# 检查 AWS CLI
if ! command -v aws &> /dev/null; then
  echo "ERROR: AWS CLI not found. Please install AWS CLI first."
  exit 1
fi

# 检查 AWS 凭证
if ! aws sts get-caller-identity &> /dev/null; then
  echo "ERROR: AWS credentials not configured. Run 'aws configure' first."
  exit 1
fi

echo "Step 1/5: Creating DynamoDB tables..."
./scripts/aws-create-tables.sh "$STAGE"

echo ""
echo "Step 2/5: Creating Lambda execution role..."
./scripts/create-execution-role.sh "ainx-lambda-execution-role-${STAGE}"

echo ""
echo "Step 3/5: Creating Lambda functions..."
./scripts/aws-create-lambdas.sh "$STAGE"

echo ""
echo "Step 4/5: Creating API Gateway..."
./scripts/aws-create-api-gateway.sh "$STAGE"

echo ""
echo "Step 5/5: Creating CloudWatch alarms..."
./scripts/aws-create-alarms.sh "$STAGE"

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Deploy Lambda code: npm run deploy:$STAGE"
echo "2. Run E2E tests: npm run test:e2e"
echo ""
echo "API Gateway URL:"
API_ID=$(aws apigateway get-rest-apis --query "items[?name=='ainx-api-${STAGE}'].id" --output text)
if [ -n "$API_ID" ]; then
  echo "  https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${STAGE}"
fi
