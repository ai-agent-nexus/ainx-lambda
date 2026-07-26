#!/bin/bash
set -e

# 部署 Lambda 函数到指定环境（支持创建新函数）
# 用法: ./deploy-lambda.sh <function-name> <zip-file-path>

FUNCTION_NAME="${1}"
ZIP_FILE="${2}"

if [ -z "$FUNCTION_NAME" ] || [ -z "$ZIP_FILE" ]; then
  echo "Usage: $0 <function-name> <zip-file-path>"
  exit 1
fi

echo "Deploying $FUNCTION_NAME..."

if aws lambda get-function --function-name "$FUNCTION_NAME" > /dev/null 2>&1; then
  # 函数存在，更新代码
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://${ZIP_FILE}"
  echo "Function $FUNCTION_NAME updated successfully."
else
  # 函数不存在，创建新函数
  echo "Function $FUNCTION_NAME does not exist. Creating new function..."
  
  # 使用默认执行角色（用户需要确保此角色存在）
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs24.x \
    --handler index.handler \
    --role "${LAMBDA_EXECUTION_ROLE_ARN:-arn:aws:iam::690687165181:role/ainx-lambda-execution-role}" \
    --zip-file "fileb://${ZIP_FILE}" \
    --timeout 30 \
    --memory-size 512
  echo "Function $FUNCTION_NAME created successfully."
fi
