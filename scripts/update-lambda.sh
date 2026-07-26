#!/bin/bash
set -e

# 更新或创建 Lambda 函数
# 用法: ./update-lambda.sh <function-name> <zip-file-path> [env-var-key=value ...]

FUNCTION_NAME="${1:-ainx-agent-registration-sit}"
ZIP_FILE="${2:-functions/agent-registration/dist/index.zip}"
shift 2 || true

# 收集环境变量参数
ENV_VARS=""
for arg in "$@"; do
  if [ -n "$ENV_VARS" ]; then
    ENV_VARS="${ENV_VARS},${arg}"
  else
    ENV_VARS="${arg}"
  fi
done

echo "Updating Lambda function: $FUNCTION_NAME..."

# 检查函数是否存在
if aws lambda get-function --function-name "$FUNCTION_NAME" > /dev/null 2>&1; then
  # 函数存在，更新代码
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://${ZIP_FILE}"
  echo "Lambda function code updated successfully."
else
  # 函数不存在，创建新函数
  echo "Function $FUNCTION_NAME not found. Creating new function..."
  
  # 从函数名推断 handler（假设都是 index.handler）
  # 从 zip 路径推断 runtime
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs24.x \
    --handler index.handler \
    --role "${LAMBDA_EXECUTION_ROLE_ARN:-arn:aws:iam::690687165181:role/ainx-lambda-execution-role}" \
    --zip-file "fileb://${ZIP_FILE}" \
    --timeout 30 \
    --memory-size 512
  echo "Lambda function created successfully."
fi

echo "Waiting for Lambda function to be active..."
aws lambda wait function-updated --function-name "$FUNCTION_NAME" 2>/dev/null || aws lambda wait function-active --function-name "$FUNCTION_NAME" 2>/dev/null || true

# 更新环境变量（如果提供了）
if [ -n "$ENV_VARS" ]; then
  echo "Updating Lambda environment variables..."
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --environment "Variables={$ENV_VARS}"
  echo "Lambda environment variables updated successfully."
  echo "  $ENV_VARS"
fi

echo "Lambda function $FUNCTION_NAME ready."
