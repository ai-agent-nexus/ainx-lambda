#!/bin/bash
# AWS SDK v2 -> v3 Migration Script for ainx-lambda

set -e

echo "=== AWS SDK v3 Migration Script ==="
echo ""

# List of files to migrate
FILES=(
  "functions/agent-registration/src/index.ts"
  "functions/agent-revoke/src/index.ts"
  "functions/agent-rotate-key/src/index.ts"
  "functions/auth-challenge/src/index.ts"
  "functions/auth-refresh/src/index.ts"
  "functions/auth-revoke/src/index.ts"
  "functions/auth-token/src/index.ts"
  "functions/connection-accept-request/src/index.ts"
  "functions/connection-accept-request/src/reject.ts"
  "functions/connection-create-invitation/src/index.ts"
  "functions/connection-list-connections/src/index.ts"
  "functions/connection-list-connections/src/list-requests.ts"
  "functions/connection-remove-connection/src/index.ts"
  "functions/connection-send-request/src/index.ts"
  "functions/jwt-authorizer/src/index.ts"
  "__tests__/connection-e2e.test.ts"
)

echo "Files to migrate: ${#FILES[@]}"
echo ""

# Step 1: Replace imports
echo "Step 1: Replacing imports..."
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    # Replace aws-sdk import with v3 imports
    sed -i '' 's/import { DynamoDB } from '"'"'aws-sdk'"'"';/import { DynamoDBClient } from '"'"'@aws-sdk\/client-dynamodb';\nimport { DynamoDBDocumentClient, TransactWriteCommand, GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, UpdateCommand } from '"'"'@aws-sdk\/lib-dynamodb';\n/" "$file"
    echo "  ✓ Updated imports in $file"
  fi
done

echo ""
echo "Step 2: Replacing DocumentClient initialization..."
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    # Replace DocumentClient initialization
    sed -i '' 's/const dynamodb = new DynamoDB.DocumentClient();/const client = new DynamoDBClient({});\nconst dynamodb = DynamoDBDocumentClient.from(client);\n/" "$file"
    echo "  ✓ Updated client initialization in $file"
  fi
done

echo ""
echo "Step 3: Replacing .promise() calls..."
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    # Remove .promise() calls
    sed -i '' 's/\.promise()//g' "$file"
    echo "  ✓ Removed .promise() calls in $file"
  fi
done

echo ""
echo "Step 4: Replacing API calls..."
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    # Replace specific API calls
    sed -i '' 's/dynamodb\.transactWrite(/await dynamodb.send(new TransactWriteCommand(/g' "$file"
    sed -i '' 's/dynamodb\.get(/await dynamodb.send(new GetCommand(/g' "$file"
    sed -i '' 's/dynamodb\.put(/await dynamodb.send(new PutCommand(/g' "$file"
    sed -i '' 's/dynamodb\.delete(/await dynamodb.send(new DeleteCommand(/g' "$file"
    sed -i '' 's/dynamodb\.query(/await dynamodb.send(new QueryCommand(/g' "$file"
    sed -i '' 's/dynamodb\.scan(/await dynamodb.send(new ScanCommand(/g' "$file"
    sed -i '' 's/dynamodb\.update(/await dynamodb.send(new UpdateCommand(/g' "$file"
    echo "  ✓ Updated API calls in $file"
  fi
done

echo ""
echo "=== Migration Complete ==="
echo ""
echo "Next steps:"
echo "1. Review the changes for any issues"
echo "2. Update package.json files to use @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb"
echo "3. Remove aws-sdk dependency"
echo "4. Run npm install"
echo "5. Run tests to verify everything works"
