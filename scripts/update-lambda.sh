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
  
  # 确定执行角色
  ROLE_ARN="${LAMBDA_EXECUTION_ROLE_ARN:-}"
  
  # 如果没有提供角色，尝试查找现有的 service-role
  if [ -z "$ROLE_ARN" ]; then
    # 尝试查找与函数名匹配的角色（SAM 生成的命名模式）
    ROLE_NAME="${FUNCTION_NAME}-role"
    if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/service-role/${ROLE_NAME}"
    fi
  fi
  
  # 如果仍然没有角色，尝试使用通用执行角色
  if [ -z "$ROLE_ARN" ]; then
    # 检查 ainx-lambda-execution-role 是否存在
    if aws iam get-role --role-name "ainx-lambda-execution-role" > /dev/null 2>&1; then
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/ainx-lambda-execution-role"
    fi
  fi
  
  if [ -z "$ROLE_ARN" ]; then
    echo "ERROR: No execution role found for $FUNCTION_NAME"
    echo ""
    echo "Options:"
    echo "1. Run locally to create a shared execution role:"
    echo "   ./scripts/create-execution-role.sh"
    echo ""
    echo "2. Set LAMBDA_EXECUTION_ROLE_ARN environment variable:"
    echo "   export LAMBDA_EXECUTION_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>"
    echo ""
    echo "3. Use AWS SAM to deploy the full stack (creates roles automatically):"
    echo "   cd infra/templates && sam deploy"
    echo ""
    exit 1
  fi
  
  echo "Using execution role: $ROLE_ARN"
  
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs24.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
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
