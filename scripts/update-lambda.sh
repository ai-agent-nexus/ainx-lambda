#!/bin/bash
set -e

# 更新 Lambda 函数代码和环境变量
# 用法: ./update-lambda.sh <function-name> <zip-file-path> [table-name]

FUNCTION_NAME="${1:-ainx-agent-registration-sit}"
ZIP_FILE="${2:-functions/agent-registration/dist/index.zip}"
TABLE_NAME="${3:-ainx-agent-registration-sit}"

echo "Updating Lambda function: $FUNCTION_NAME..."

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://${ZIP_FILE}"

echo "Lambda function updated successfully."

# Wait for Lambda to be Active before updating configuration
echo "Waiting for Lambda function to be active..."
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

# Update environment variables
echo "Updating Lambda environment variables..."
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --environment "Variables={AGENT_REGISTRATION_TABLE_NAME=$TABLE_NAME}"

echo "Lambda environment variables updated successfully."
