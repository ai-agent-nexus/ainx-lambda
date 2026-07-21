#!/bin/bash
set -e

# 更新 Lambda 函数代码
# 用法: ./update-lambda.sh <function-name> <zip-file-path>

FUNCTION_NAME="${1:-ainx-agent-registration-sit}"
ZIP_FILE="${2:-functions/agent-registration/dist/index.zip}"

echo "Updating Lambda function: $FUNCTION_NAME..."

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://${ZIP_FILE}"

echo "Lambda function updated successfully."
