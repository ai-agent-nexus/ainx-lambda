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
  echo "Function $FUNCTION_NAME created successfully."
fi
