#!/bin/bash
set -e

# 创建 Lambda 执行角色（如果不存在）
# 用法: ./scripts/create-execution-role.sh <role-name>

ROLE_NAME="${1:-ainx-lambda-execution-role}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "Checking execution role: $ROLE_NAME..."

# 检查角色是否存在
if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
  echo "Role $ROLE_NAME already exists."
  echo "ROLE_ARN=$ROLE_ARN"
  exit 0
fi

echo "Creating execution role: $ROLE_NAME..."

# 创建信任策略文档
cat > /tmp/trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# 创建角色
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/trust-policy.json

# 附加基本执行策略（CloudWatch Logs 权限）
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

echo "Waiting for IAM role propagation (10 seconds)..."
sleep 10

echo "Role $ROLE_NAME created successfully."
echo "ROLE_ARN=$ROLE_ARN"
echo ""
echo "Usage in CI/CD:"
echo "  export LAMBDA_EXECUTION_ROLE_ARN=$ROLE_ARN"
