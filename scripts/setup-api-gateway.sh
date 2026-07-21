#!/bin/bash
set -e

# 创建或更新 API Gateway
# 用法: ./setup-api-gateway.sh <api-name> <function-name> <stage-name> <region>

API_NAME="${1:-ainx-api-sit}"
FUNCTION_NAME="${2:-ainx-agent-registration-sit}"
STAGE_NAME="${3:-sit}"
REGION="${4:-ap-southeast-1}"

echo "Setting up API Gateway: $API_NAME"

# Get Lambda function ARN
LAMBDA_ARN=$(aws lambda get-function --function-name "$FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)
echo "Lambda ARN: $LAMBDA_ARN"

# Check if API Gateway exists
API_ID=$(aws apigateway get-rest-apis --query "items[?name=='$API_NAME'].id" --output text)

if [ -z "$API_ID" ]; then
  echo "Creating API Gateway..."
  
  # Create REST API
  API_ID=$(aws apigateway create-rest-api --name "$API_NAME" --query 'id' --output text)
  echo "Created API Gateway with ID: $API_ID"
  
  # Wait a moment for API to be ready
  sleep 2
  
  # Get root resource id
  ROOT_RESOURCE_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --query 'items[0].id' --output text)
  echo "Root resource ID: $ROOT_RESOURCE_ID"
  
  # Create /agents resource
  AGENTS_RESOURCE_ID=$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$ROOT_RESOURCE_ID" --path-part "agents" --query 'id' --output text)
  echo "Created /agents resource with ID: $AGENTS_RESOURCE_ID"
  
  # Create /register resource
  REGISTER_RESOURCE_ID=$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$AGENTS_RESOURCE_ID" --path-part "register" --query 'id' --output text)
  echo "Created /register resource with ID: $REGISTER_RESOURCE_ID"
  
  # Create POST method
  aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$REGISTER_RESOURCE_ID" --http-method POST --authorization-type NONE
  echo "Created POST method"
  
  # Create Lambda integration
  aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$REGISTER_RESOURCE_ID" --http-method POST --type AWS_PROXY --integration-http-method POST --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations"
  echo "Created Lambda integration"
  
  # Create deployment
  aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name "$STAGE_NAME"
  echo "Created deployment to stage: $STAGE_NAME"
  
  # Add Lambda permission for API Gateway
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  aws lambda add-permission --function-name "$FUNCTION_NAME" --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/POST/agents/register" || true
  
  echo "API Gateway created: https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}"
else
  echo "API Gateway already exists: $API_ID"
fi

echo "API_GATEWAY_ID=$API_ID"
