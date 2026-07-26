#!/bin/bash
set -e

# Create API Gateway for AINX
# 用法: ./scripts/aws-create-api-gateway.sh <stage>

STAGE="${1:-sit}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "Creating API Gateway for stage: $STAGE"

# 检查 API Gateway 是否已存在
API_NAME="ainx-api-${STAGE}"
API_ID=$(aws apigateway get-rest-apis --query "items[?name=='${API_NAME}'].id" --output text --region "$AWS_REGION")

if [ -n "$API_ID" ]; then
  echo "  API Gateway $API_NAME already exists (ID: $API_ID), skipping creation..."
else
  echo "  Creating API Gateway: $API_NAME"
  API_ID=$(aws apigateway create-rest-api \
    --name "$API_NAME" \
    --description "AINX API Gateway for ${STAGE}" \
    --endpoint-configuration types=REGIONAL \
    --region "$AWS_REGION" \
    --query 'id' \
    --output text)
  echo "  API Gateway created (ID: $API_ID)"
fi

# 获取根资源 ID
ROOT_RESOURCE_ID=$(aws apigateway get-resources \
  --rest-api-id "$API_ID" \
  --query 'items[?path==\`/\`].id' \
  --output text \
  --region "$AWS_REGION")

# 创建资源的辅助函数
create_resource() {
  local parent_id="$1"
  local path_part="$2"
  
  # 检查资源是否已存在
  local existing_id=$(aws apigateway get-resources \
    --rest-api-id "$API_ID" \
    --query "items[?pathPart=='${path_part}'].id" \
    --output text \
    --region "$AWS_REGION")
  
  if [ -n "$existing_id" ]; then
    echo "$existing_id"
    return 0
  fi
  
  aws apigateway create-resource \
    --rest-api-id "$API_ID" \
    --parent-id "$parent_id" \
    --path-part "$path_part" \
    --query 'id' \
    --output text \
    --region "$AWS_REGION"
}

# 创建 /agents 资源
echo "  Creating resources..."
AGENTS_RESOURCE_ID=$(create_resource "$ROOT_RESOURCE_ID" "agents")

# 创建 /agents/register 资源
REGISTER_RESOURCE_ID=$(create_resource "$AGENTS_RESOURCE_ID" "register")

# 创建 /agents/rotate-key 资源
ROTATE_KEY_RESOURCE_ID=$(create_resource "$AGENTS_RESOURCE_ID" "rotate-key")

# 创建 /agents/{did} 资源
AGENT_DID_RESOURCE_ID=$(create_resource "$AGENTS_RESOURCE_ID" "{did}")

# 创建 /auth 资源
AUTH_RESOURCE_ID=$(create_resource "$ROOT_RESOURCE_ID" "auth")

# 创建 /auth/challenge 资源
CHALLENGE_RESOURCE_ID=$(create_resource "$AUTH_RESOURCE_ID" "challenge")

# 创建 /auth/token 资源
TOKEN_RESOURCE_ID=$(create_resource "$AUTH_RESOURCE_ID" "token")

# 创建 /auth/refresh 资源
REFRESH_RESOURCE_ID=$(create_resource "$AUTH_RESOURCE_ID" "refresh")

# 创建 /auth/revoke 资源
REVOKE_RESOURCE_ID=$(create_resource "$AUTH_RESOURCE_ID" "revoke")

# 创建方法的辅助函数
create_method() {
  local resource_id="$1"
  local method="$2"
  local auth_type="$3"  # NONE or AWS_IAM
  
  # 检查方法是否已存在
  if aws apigateway get-method \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method "$method" \
    --region "$AWS_REGION" &> /dev/null; then
    echo "    Method $method already exists"
    return 0
  fi
  
  if [ "$auth_type" = "NONE" ]; then
    aws apigateway put-method \
      --rest-api-id "$API_ID" \
      --resource-id "$resource_id" \
      --http-method "$method" \
      --authorization-type NONE \
      --region "$AWS_REGION" &> /dev/null
  else
    aws apigateway put-method \
      --rest-api-id "$API_ID" \
      --resource-id "$resource_id" \
      --http-method "$method" \
      --authorization-type CUSTOM \
      --authorizer-id "$AUTHORIZER_ID" \
      --region "$AWS_REGION" &> /dev/null
  fi
  echo "    Method $method created"
}

# 创建 Lambda 集成的辅助函数
create_integration() {
  local resource_id="$1"
  local method="$2"
  local function_name="$3"
  
  echo "    Creating integration for $function_name"
  aws apigateway put-integration \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method "$method" \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${function_name}/invocations" \
    --region "$AWS_REGION" &> /dev/null
}

# 创建 Lambda 权限的辅助函数
create_lambda_permission() {
  local function_name="$1"
  local source_arn="arn:aws:execute-api:${AWS_REGION}:${ACCOUNT_ID}:${API_ID}/*"
  
  # 检查权限是否已存在
  if aws lambda get-policy --function-name "$function_name" --region "$AWS_REGION" 2>/dev/null | grep -q "$API_ID"; then
    echo "    Permission for $function_name already exists"
    return 0
  fi
  
  aws lambda add-permission \
    --function-name "$function_name" \
    --statement-id "apigateway-${API_ID}" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "$source_arn" \
    --region "$AWS_REGION" &> /dev/null || true
  echo "    Permission created for $function_name"
}

echo "  Creating methods and integrations..."

# /agents/register POST (no auth)
create_method "$REGISTER_RESOURCE_ID" "POST" "NONE"
create_integration "$REGISTER_RESOURCE_ID" "POST" "ainx-agent-registration-${STAGE}"
create_lambda_permission "ainx-agent-registration-${STAGE}"

# /agents/rotate-key POST (with auth)
create_method "$ROTATE_KEY_RESOURCE_ID" "POST" "AWS_IAM"
create_integration "$ROTATE_KEY_RESOURCE_ID" "POST" "ainx-agent-rotate-key-${STAGE}"
create_lambda_permission "ainx-agent-rotate-key-${STAGE}"

# /agents/{did} DELETE (with auth)
create_method "$AGENT_DID_RESOURCE_ID" "DELETE" "AWS_IAM"
create_integration "$AGENT_DID_RESOURCE_ID" "DELETE" "ainx-agent-revoke-${STAGE}"
create_lambda_permission "ainx-agent-revoke-${STAGE}"

# /auth/challenge POST (no auth)
create_method "$CHALLENGE_RESOURCE_ID" "POST" "NONE"
create_integration "$CHALLENGE_RESOURCE_ID" "POST" "ainx-auth-challenge-${STAGE}"
create_lambda_permission "ainx-auth-challenge-${STAGE}"

# /auth/token POST (no auth)
create_method "$TOKEN_RESOURCE_ID" "POST" "NONE"
create_integration "$TOKEN_RESOURCE_ID" "POST" "ainx-auth-token-${STAGE}"
create_lambda_permission "ainx-auth-token-${STAGE}"

# /auth/refresh POST (no auth)
create_method "$REFRESH_RESOURCE_ID" "POST" "NONE"
create_integration "$REFRESH_RESOURCE_ID" "POST" "ainx-auth-refresh-${STAGE}"
create_lambda_permission "ainx-auth-refresh-${STAGE}"

# /auth/revoke POST (with auth)
create_method "$REVOKE_RESOURCE_ID" "POST" "AWS_IAM"
create_integration "$REVOKE_RESOURCE_ID" "POST" "ainx-auth-revoke-${STAGE}"
create_lambda_permission "ainx-auth-revoke-${STAGE}"

# 部署 API Gateway
echo ""
echo "  Deploying API Gateway to stage: $STAGE"
aws apigateway create-deployment \
  --rest-api-id "$API_ID" \
  --stage-name "$STAGE" \
  --region "$AWS_REGION" &> /dev/null || {
    echo "    Deployment already exists, updating..."
    aws apigateway create-deployment \
      --rest-api-id "$API_ID" \
      --stage-name "$STAGE" \
      --region "$AWS_REGION" &> /dev/null
  }

# 启用 CORS
echo "  Enabling CORS..."
for resource_id in "$ROOT_RESOURCE_ID" "$AGENTS_RESOURCE_ID" "$REGISTER_RESOURCE_ID" "$ROTATE_KEY_RESOURCE_ID" "$AGENT_DID_RESOURCE_ID" "$AUTH_RESOURCE_ID" "$CHALLENGE_RESOURCE_ID" "$TOKEN_RESOURCE_ID" "$REFRESH_RESOURCE_ID" "$REVOKE_RESOURCE_ID"; do
  aws apigateway put-method-response \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters "method.response.header.Access-Control-Allow-Headers=true,method.response.header.Access-Control-Allow-Methods=true,method.response.header.Access-Control-Allow-Origin=true" \
    --region "$AWS_REGION" &> /dev/null || true
  
  aws apigateway put-integration-response \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters "method.response.header.Access-Control-Allow-Headers='Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',method.response.header.Access-Control-Allow-Methods='GET,POST,PUT,DELETE,OPTIONS',method.response.header.Access-Control-Allow-Origin='*'" \
    --region "$AWS_REGION" &> /dev/null || true
done

echo ""
echo "API Gateway created successfully!"
echo "API URL: https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${STAGE}"
