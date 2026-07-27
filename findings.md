# AINX Lambda Implementation Findings

## Codebase Analysis

### Existing Architecture

- **Monorepo**: NPM Workspaces
- **Runtime**: Node.js 24.x
- **Language**: TypeScript 5.8+
- **Build**: esbuild
- **Test**: Jest + ts-jest
- **Infra**: AWS SAM (template.yaml)
- **CI/CD**: GitHub Actions

### Existing Functions

1. **agent-registration** (functions/agent-registration/)
   - Handler: src/index.ts
   - Tests: **tests**/{unit,integration,e2e}.test.ts
   - Package: @ainx/agent-registration

2. **auth** (functions/auth/)
   - Handler: src/index.ts
   - Tests: **tests**/{unit,integration,e2e}.test.ts
   - Package: @ainx/auth

3. **agent-rotate-key** (functions/agent-rotate-key/)
   - Handler: src/index.ts
   - Tests: **tests**/{unit,integration,e2e}.test.ts
   - Package: @ainx/agent-rotate-key

### Shared Packages

1. **@ainx/logger** - Structured JSON logging
2. **@ainx/shared-utils** - formatResponse, parseBody, validateInput, generateId
3. **@ainx/did-utils** - DID key parsing (ed25519)
4. **@ainx/crypto-utils** - Signature verification

### Infrastructure

- **template.yaml**: SAM template with 3 Lambda functions, 3 DynamoDB tables
- **DynamoDB Tables**:
  - ainx-agent-registration-{stage} (HASH: userId, RANGE: did)
  - ainx-did-uniqueness-{stage} (HASH: did)
  - ainx-nonce-{stage} (HASH: nonce)

### Test Patterns

- **Unit Tests**: Mock all dependencies (DynamoDB, crypto, etc.)
- **Integration Tests**: Mock DynamoDB with in-memory state
- **E2E Tests**: Real HTTP calls to deployed API Gateway

### Key Patterns

1. Error handling: Try-catch with logger.error
2. Response format: formatResponse(statusCode, { error, code })
3. DynamoDB: DocumentClient with .promise()
4. DID validation: parseDidKey() from @ainx/did-utils
5. Signature verification: verifySignature() from @ainx/crypto-utils

## Implementation Notes

### JWT Implementation

- Library: jsonwebtoken (already in devDependencies)
- Algorithm: RS256
- Key storage: AWS Secrets Manager (not implemented yet, using env vars for now)
- Token structure: { sub, did, iat, exp, iss, jti, scope }

### Challenge-Response Flow

1. Client requests challenge (POST /auth/challenge)
2. Server generates random challenge, stores in DynamoDB (TTL: 5min)
3. Client signs challenge with private key
4. Client sends signed challenge (POST /auth/token)
5. Server verifies signature, generates JWT + refresh token

### DynamoDB Table Designs

#### Challenge Table

```yaml
TableName: ainx-challenge-{stage}
KeySchema:
  - AttributeName: did
    KeyType: HASH
AttributeDefinitions:
  - AttributeName: did
    AttributeType: S
TimeToLiveSpecification:
  AttributeName: ttl
  Enabled: true
```

#### Refresh Token Table

```yaml
TableName: ainx-refresh-token-{stage}
KeySchema:
  - AttributeName: token
    KeyType: HASH
GlobalSecondaryIndexes:
  - IndexName: UserIdIndex
    KeySchema:
      - AttributeName: userId
        KeyType: HASH
    Projection:
      ProjectionType: ALL
```

#### Token Blacklist Table

```yaml
TableName: ainx-token-blacklist-{stage}
KeySchema:
  - AttributeName: jti
    KeyType: HASH
TimeToLiveSpecification:
  AttributeName: ttl
  Enabled: true
```

## Dependencies to Add

- jsonwebtoken: ^9.0.0 (for JWT signing/verification)
- uuid: ^9.0.0 (for generating refresh tokens)

## Files to Modify

1. **package.json** - Add new workspaces, dependencies
2. **jest.config.js** - Add moduleNameMapper for new packages
3. **infra/templates/template.yaml** - Add new Lambda functions, DynamoDB tables, IAM policies
4. **.github/workflows/ci-cd.yml** - Add new functions to build matrix

## Risks & Mitigations

1. **JWT Key Management**: Use AWS Secrets Manager (Phase 2)
2. **Token Blacklist Performance**: Use DynamoDB TTL for automatic cleanup
3. **Backward Compatibility**: Keep existing auth Lambda until JWT system is fully deployed
