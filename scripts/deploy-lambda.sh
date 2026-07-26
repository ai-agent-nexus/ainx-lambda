#!/bin/bash
set -e

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
  echo "Function $FUNCTION_NAME does not exist. Creating new function..."
  
  ROLE_ARN="${LAMBDA_EXECUTION_ROLE_ARN:-}"
  
  if [ -z "$ROLE_ARN" ]; then
    ROLE_NAME="${FUNCTION_NAME}-role"
    if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/service-role/${ROLE_NAME}"
    fi
  fi
  
  if [ -z "$ROLE_ARN" ]; then
    if aws iam get-role --role-name "ainx-lambda-execution-role" > /dev/null 2>&1; then
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/ainx-lambda-execution-role"
    fi
  fi
  
  if [ -z "$ROLE_ARN" ]; then
    STAGE=$(echo "$FUNCTION_NAME" | sed 's/.*-\(sit\|uat\|prod\)$/\1/')
    ROLE_NAME="ainx-lambda-execution-role-${STAGE}"
    
    if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
    else
      echo "  Creating execution role: $ROLE_NAME"
      
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
      
      aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document file:///tmp/trust-policy.json \
        --description "AINX Lambda execution role for ${STAGE}"
      
      aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      
      echo "  Waiting for IAM role propagation (10 seconds)..."
      sleep 10
      
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
      echo "  Role $ROLE_NAME created: $ROLE_ARN"
    fi
  fi
  
  if [ -z "$ROLE_ARN" ]; then
    echo "ERROR: Could not determine execution role for $FUNCTION_NAME"
    echo ""
    echo "Options:"
    echo "1. Set LAMBDA_EXECUTION_ROLE_ARN environment variable"
    echo "2. Run infrastructure setup first: ./scripts/aws-setup.sh <stage>"
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
