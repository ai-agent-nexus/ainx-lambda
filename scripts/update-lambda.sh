#!/bin/bash
set -e

FUNCTION_NAME="${1:-ainx-agent-registration-sit}"
ZIP_FILE="${2:-functions/agent-registration/dist/index.zip}"
AGENT_TABLE_NAME="${3:-ainx-agent-registration-sit}"
DID_UNIQUENESS_TABLE_NAME="${4:-ainx-did-uniqueness-sit}"
NONCE_TABLE_NAME="${5:-ainx-nonce-sit}"

echo "Updating Lambda function: $FUNCTION_NAME..."

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://${ZIP_FILE}"

echo "Lambda function updated successfully."

echo "Waiting for Lambda function to be active..."
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

echo "Updating Lambda environment variables..."
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --environment "Variables={AGENT_REGISTRATION_TABLE_NAME=$AGENT_TABLE_NAME,DID_UNIQUENESS_TABLE_NAME=$DID_UNIQUENESS_TABLE_NAME,NONCE_TABLE_NAME=$NONCE_TABLE_NAME}"

echo "Lambda environment variables updated successfully."
echo "  AGENT_REGISTRATION_TABLE_NAME=$AGENT_TABLE_NAME"
echo "  DID_UNIQUENESS_TABLE_NAME=$DID_UNIQUENESS_TABLE_NAME"
echo "  NONCE_TABLE_NAME=$NONCE_TABLE_NAME"
