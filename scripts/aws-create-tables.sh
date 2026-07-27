#!/bin/bash
set -e

# Create DynamoDB tables for AINX
# 用法: ./scripts/aws-create-tables.sh <stage>

STAGE="${1:-sit}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"

echo "Creating DynamoDB tables for stage: $STAGE"

# Helper function to check if table exists
table_exists() {
  aws dynamodb describe-table --table-name "$1" --region "$AWS_REGION" &> /dev/null
}

# Helper function to create table with error handling
create_table() {
  local table_name="$1"
  local create_cmd="$2"
  
  if table_exists "$table_name"; then
    echo "  Table $table_name already exists, skipping..."
    return 0
  fi
  
  echo "  Creating table: $table_name"
  eval "$create_cmd" || {
    echo "  ERROR: Failed to create table $table_name"
    return 1
  }
  echo "  Table $table_name created successfully"
}

# 1. Agent Registration Table
create_table "ainx-agent-registration-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-agent-registration-${STAGE} \
    --attribute-definitions \
      AttributeName=userId,AttributeType=S \
      AttributeName=did,AttributeType=S \
      AttributeName=status,AttributeType=S \
    --key-schema \
      AttributeName=userId,KeyType=HASH \
      AttributeName=did,KeyType=RANGE \
    --global-secondary-indexes \
      'IndexName=DidIndex,KeySchema=[{AttributeName=did,KeyType=HASH}],Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=1,WriteCapacityUnits=1}' \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

# 2. DID Uniqueness Table
create_table "ainx-did-uniqueness-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-did-uniqueness-${STAGE} \
    --attribute-definitions AttributeName=did,AttributeType=S \
    --key-schema AttributeName=did,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

# 3. Nonce Table
create_table "ainx-nonce-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-nonce-${STAGE} \
    --attribute-definitions AttributeName=nonce,AttributeType=S \
    --key-schema AttributeName=nonce,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

# 4. Challenge Table
create_table "ainx-challenge-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-challenge-${STAGE} \
    --attribute-definitions AttributeName=did,AttributeType=S \
    --key-schema AttributeName=did,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

# 5. Refresh Token Table
create_table "ainx-refresh-token-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-refresh-token-${STAGE} \
    --attribute-definitions \
      AttributeName=token,AttributeType=S \
      AttributeName=userId,AttributeType=S \
    --key-schema AttributeName=token,KeyType=HASH \
    --global-secondary-indexes \
      'IndexName=UserIdIndex,KeySchema=[{AttributeName=userId,KeyType=HASH}],Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=1,WriteCapacityUnits=1}' \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

# 6. Token Blacklist Table
create_table "ainx-token-blacklist-${STAGE}" \
  "aws dynamodb create-table \
    --table-name ainx-token-blacklist-${STAGE} \
    --attribute-definitions AttributeName=jti,AttributeType=S \
    --key-schema AttributeName=jti,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
    --region ${AWS_REGION}"

echo ""
echo "Enabling TTL on tables..."

# Enable TTL on tables that need it
for table in \
  "ainx-agent-registration-${STAGE}" \
  "ainx-did-uniqueness-${STAGE}" \
  "ainx-nonce-${STAGE}" \
  "ainx-challenge-${STAGE}" \
  "ainx-refresh-token-${STAGE}" \
  "ainx-token-blacklist-${STAGE}"; do
  
  echo "  Enabling TTL on $table"
  aws dynamodb update-time-to-live \
    --table-name "$table" \
    --time-to-live-specification AttributeName=ttl,Enabled=true \
    --region "$AWS_REGION" || echo "    TTL already enabled or not applicable"
done

echo ""
echo "DynamoDB tables created successfully!"
