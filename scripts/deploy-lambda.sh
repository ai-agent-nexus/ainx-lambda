#!/bin/bash
set -e

# 部署 Lambda 函数到指定环境
# 用法: ./deploy-lambda.sh <function-name> <zip-file-path>

FUNCTION_NAME="${1}"
ZIP_FILE="${2}"

if [ -z "$FUNCTION_NAME" ] || [ -z "$ZIP_FILE" ]; then
  echo "Usage: $0 <function-name> <zip-file-path>"
  exit 1
fi

echo "Deploying $FUNCTION_NAME..."

if aws lambda get-function --function-name "$FUNCTION_NAME" > /dev/null 2>&1; then
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://${ZIP_FILE}"
  echo "Function $FUNCTION_NAME updated successfully."
else
  echo "Function $FUNCTION_NAME does not exist. Skipping..."
fi
