#!/bin/bash
set -e

# Create Lambda functions for AINX
# 用法: ./scripts/aws-create-lambdas.sh <stage>

STAGE="${1:-sit}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="ainx-lambda-execution-role-${STAGE}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "Creating Lambda functions for stage: $STAGE"

if ! aws iam get-role --role-name "$ROLE_NAME" &> /dev/null; then
  echo "ERROR: Execution role not found: $ROLE_ARN"
  echo ""
  echo "Create the role first with AWS CLI:"
  echo "  aws iam create-role \\"
  echo "    --role-name $ROLE_NAME \\"
  echo "    --assume-role-policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}' \\"
  echo "    --description 'AINX Lambda execution role for $STAGE'"
  echo ""
  echo "Then attach the basic execution policy:"
  echo "  aws iam attach-role-policy \\"
  echo "    --role-name $ROLE_NAME \\"
  echo "    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  echo ""
  exit 1
fi

echo "  Using role: $ROLE_ARN"

# 通用 Lambda 创建函数
create_lambda() {
  local function_name="$1"
  local description="$2"
  local env_vars="$3"
  
  if aws lambda get-function --function-name "$function_name" --region "$AWS_REGION" &> /dev/null; then
    echo "  Function $function_name already exists, skipping..."
    return 0
  fi
  
  echo "  Creating function: $function_name"
  
  # 创建临时 zip（空函数，后续通过 CI/CD 部署真实代码）
  local temp_dir=$(mktemp -d)
  cat > "$temp_dir/index.js" << 'EOF'
exports.handler = async (event) => {
  console.log('Placeholder function');
  return { statusCode: 200, body: JSON.stringify({ message: 'Placeholder' }) };
};
EOF
  cd "$temp_dir" && zip -r index.zip index.js &> /dev/null && cd - &> /dev/null
  
  if [ -n "$env_vars" ]; then
    aws lambda create-function \
      --function-name "$function_name" \
      --runtime nodejs24.x \
      --handler index.handler \
      --role "$ROLE_ARN" \
      --zip-file "fileb://${temp_dir}/index.zip" \
      --description "$description" \
      --timeout 30 \
      --memory-size 512 \
      --environment "Variables={$env_vars}" \
      --region "$AWS_REGION"
  else
    aws lambda create-function \
      --function-name "$function_name" \
      --runtime nodejs24.x \
      --handler index.handler \
      --role "$ROLE_ARN" \
      --zip-file "fileb://${temp_dir}/index.zip" \
      --description "$description" \
      --timeout 30 \
      --memory-size 512 \
      --region "$AWS_REGION"
  fi
  
  rm -rf "$temp_dir"
  echo "  Function $function_name created successfully"
}

# 1. Agent Registration
create_lambda \
  "ainx-agent-registration-${STAGE}" \
  "Agent registration Lambda function" \
  "AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},DID_UNIQUENESS_TABLE_NAME=ainx-did-uniqueness-${STAGE}"

# 2. Auth
create_lambda \
  "ainx-auth-${STAGE}" \
  "Auth Lambda function for DID verification" \
  "AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},NONCE_TABLE_NAME=ainx-nonce-${STAGE}"

# 3. Agent Rotate Key
create_lambda \
  "ainx-agent-rotate-key-${STAGE}" \
  "Agent rotate-key Lambda function" \
  "AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},DID_UNIQUENESS_TABLE_NAME=ainx-did-uniqueness-${STAGE},NONCE_TABLE_NAME=ainx-nonce-${STAGE}"

# 4. Auth Challenge
create_lambda \
  "ainx-auth-challenge-${STAGE}" \
  "Auth challenge generation Lambda function" \
  "CHALLENGE_TABLE_NAME=ainx-challenge-${STAGE}"

# 5. Auth Token
create_lambda \
  "ainx-auth-token-${STAGE}" \
  "Auth token issuance Lambda function" \
  "AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},CHALLENGE_TABLE_NAME=ainx-challenge-${STAGE},REFRESH_TOKEN_TABLE_NAME=ainx-refresh-token-${STAGE},JWT_ISSUER=ainx-api,JWT_EXPIRES_IN_SECONDS=3600,REFRESH_TOKEN_TTL_DAYS=7"

# 6. Auth Refresh
create_lambda \
  "ainx-auth-refresh-${STAGE}" \
  "Auth token refresh Lambda function" \
  "REFRESH_TOKEN_TABLE_NAME=ainx-refresh-token-${STAGE},AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},JWT_ISSUER=ainx-api,JWT_EXPIRES_IN_SECONDS=3600,REFRESH_TOKEN_TTL_DAYS=7"

# 7. Auth Revoke
create_lambda \
  "ainx-auth-revoke-${STAGE}" \
  "Auth token revocation Lambda function" \
  "REFRESH_TOKEN_TABLE_NAME=ainx-refresh-token-${STAGE},TOKEN_BLACKLIST_TABLE_NAME=ainx-token-blacklist-${STAGE},JWT_ISSUER=ainx-api,BLACKLIST_TTL_SECONDS=3600"

# 8. JWT Authorizer
create_lambda \
  "ainx-jwt-authorizer-${STAGE}" \
  "JWT authorizer Lambda function for API Gateway" \
  "TOKEN_BLACKLIST_TABLE_NAME=ainx-token-blacklist-${STAGE},JWT_ISSUER=ainx-api"

# 9. Agent Revoke
create_lambda \
  "ainx-agent-revoke-${STAGE}" \
  "Agent revocation Lambda function" \
  "AGENT_REGISTRATION_TABLE_NAME=ainx-agent-registration-${STAGE},DID_UNIQUENESS_TABLE_NAME=ainx-did-uniqueness-${STAGE},REFRESH_TOKEN_TABLE_NAME=ainx-refresh-token-${STAGE},JWT_ISSUER=ainx-api"

echo ""
echo "Lambda functions created successfully!"
echo ""
echo "Note: Functions created with placeholder code."
echo "Run CI/CD deployment to update with actual code."
