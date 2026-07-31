process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as registrationHandler } from '../functions/agent-registration/src/index';
import { handler as rotateKeyHandler } from '../functions/agent-rotate-key/src/index';
import { handler as revokeHandler } from '../functions/agent-revoke/src/index';

// Mock dependencies
jest.mock('@ainx/logger');

jest.mock('@ainx/shared-utils', () => ({
  formatResponse: jest.fn((statusCode: number, body: Record<string, unknown>) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(body),
  })),
  validateInput: jest.fn((input: Record<string, unknown>, requiredFields: string[]) => {
    const missingFields = requiredFields.filter((field) => !input[field]);
    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }),
  parseBody: jest.fn((body: string | null) => {
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }),
}));

jest.mock('@ainx/did-utils', () => ({
  parseDidKey: jest.fn((did: string) => {
    if (!did || !did.startsWith('did:key:')) {
      throw new Error('Invalid DID format');
    }
    return {
      method: 'key',
      publicKey: Buffer.from('a'.repeat(32)),
      keyType: 'ed25519',
    };
  }),
}));

jest.mock('@ainx/crypto-utils', () => ({
  verifySignature: jest.fn((_publicKey: Buffer, message: string, signature: Buffer) => {
    // For testing, accept any signature for valid messages
    return signature.length > 0 && message.length > 0;
  }),
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({
    sub: 'test-user-id',
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'ainx-api',
    jti: 'test-jti-123',
    scope: 'agent:read agent:write',
  })),
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor() {
      super('Token expired');
      this.name = 'TokenExpiredError';
    }
  },
  JsonWebTokenError: class JsonWebTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'JsonWebTokenError';
    }
  },
}));

// Track DynamoDB state for integration tests
const dynamoDBState = {
  agents: new Map<string, unknown>(),
  didUniqueness: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
  nonces: new Map<string, unknown>(),
};

const mockPutFn = jest.fn(
  (params: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }) => ({
    promise: jest.fn().mockImplementation(() => {
      const { TableName, Item, ConditionExpression } = params;
      if (TableName.includes('agent-registration')) {
        const did = Item.did as string;
        if (ConditionExpression && ConditionExpression.includes('attribute_not_exists')) {
          if (dynamoDBState.agents.has(did)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'TransactionCanceledException';
            throw error;
          }
        }
        dynamoDBState.agents.set(did, Item);
      } else if (TableName.includes('did-uniqueness')) {
        const did = Item.did as string;
        if (ConditionExpression && ConditionExpression.includes('attribute_not_exists')) {
          if (dynamoDBState.didUniqueness.has(did)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'TransactionCanceledException';
            throw error;
          }
        }
        dynamoDBState.didUniqueness.set(did, Item);
      } else if (TableName.includes('refresh-token')) {
        dynamoDBState.refreshTokens.set(Item.token as string, Item);
      } else if (TableName.includes('nonce')) {
        const nonce = Item.nonce as string;
        if (ConditionExpression && ConditionExpression.includes('attribute_not_exists')) {
          if (dynamoDBState.nonces.has(nonce)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'ConditionalCheckFailedException';
            throw error;
          }
        }
        dynamoDBState.nonces.set(nonce, Item);
      }
      return Promise.resolve({});
    }),
  })
);

const mockGetFn = jest.fn((params: { TableName: string; Key: Record<string, unknown> }) => {
  const { TableName, Key } = params;
  if (TableName.includes('agent-registration')) {
    const did = Key.did as string;
    const item = dynamoDBState.agents.get(did);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }
  return {
    promise: jest.fn().mockResolvedValue({ Item: undefined }),
  };
});

const mockQueryFn = jest.fn(
  (params: {
    TableName: string;
    ExpressionAttributeValues: Record<string, unknown>;
    FilterExpression?: string;
  }) => {
    const { TableName, ExpressionAttributeValues, FilterExpression } = params;
    if (TableName.includes('agent-registration')) {
      const did = ExpressionAttributeValues[':did'] as string;
      const items: Array<Record<string, unknown>> = [];
      for (const [, item] of dynamoDBState.agents) {
        const agentItem = item as Record<string, unknown>;
        if (agentItem.did === did) {
          if (FilterExpression && FilterExpression.includes(':status')) {
            const statusFilter = ExpressionAttributeValues[':status'] as string;
            if (agentItem.status === statusFilter) {
              items.push(agentItem);
            }
          } else {
            items.push(agentItem);
          }
        }
      }
      return {
        promise: jest.fn().mockResolvedValue({ Items: items }),
      };
    } else if (TableName.includes('refresh-token')) {
      const userId = ExpressionAttributeValues[':userId'] as string;
      const tokens: Array<Record<string, unknown>> = [];
      for (const [, item] of dynamoDBState.refreshTokens) {
        const tokenItem = item as Record<string, unknown>;
        if (tokenItem.userId === userId) {
          tokens.push(tokenItem);
        }
      }
      return {
        promise: jest.fn().mockResolvedValue({ Items: tokens }),
      };
    }
    return {
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    };
  }
);

const mockUpdateFn = jest.fn(
  (params: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  }) => {
    const { TableName, Key, ExpressionAttributeValues } = params;
    if (TableName.includes('agent-registration')) {
      const did = Key.did as string;
      const existing = dynamoDBState.agents.get(did) as Record<string, unknown>;
      if (existing) {
        existing.status = ExpressionAttributeValues[':status'];
        existing.revokedAt = ExpressionAttributeValues[':revokedAt'];
        existing.updatedAt = ExpressionAttributeValues[':updatedAt'];
      }
    }
    return {
      promise: jest.fn().mockResolvedValue({}),
    };
  }
);

const mockDeleteFn = jest.fn((params: { TableName: string; Key: Record<string, unknown> }) => {
  const { TableName, Key } = params;
  if (TableName.includes('refresh-token')) {
    const token = Key.token as string;
    dynamoDBState.refreshTokens.delete(token);
  }
  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

const mockTransactWriteFn = jest.fn((params: { TransactItems: Array<unknown> }) => ({
  promise: jest.fn().mockImplementation(() => {
    const transactItems = params.TransactItems as Array<{
      Put?: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string };
      Update?: {
        TableName: string;
        Key: Record<string, unknown>;
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    }>;

    for (const item of transactItems) {
      if (item.Put) {
        const { TableName, Item, ConditionExpression } = item.Put;
        if (TableName.includes('agent-registration')) {
          const did = Item.did as string;
          if (ConditionExpression && ConditionExpression.includes('attribute_not_exists')) {
            if (dynamoDBState.agents.has(did)) {
              const error = new Error('TransactionCanceledException');
              error.name = 'TransactionCanceledException';
              throw error;
            }
          }
          dynamoDBState.agents.set(did, Item);
        } else if (TableName.includes('did-uniqueness')) {
          const did = Item.did as string;
          if (ConditionExpression && ConditionExpression.includes('attribute_not_exists')) {
            if (dynamoDBState.didUniqueness.has(did)) {
              const error = new Error('TransactionCanceledException');
              error.name = 'TransactionCanceledException';
              throw error;
            }
          }
          dynamoDBState.didUniqueness.set(did, Item);
        }
      } else if (item.Update) {
        const { TableName, Key, ExpressionAttributeValues } = item.Update;
        if (TableName.includes('agent-registration')) {
          const did = Key.did as string;
          const existing = dynamoDBState.agents.get(did) as Record<string, unknown>;
          if (existing) {
            existing.status = ExpressionAttributeValues[':status'];
            existing.revokedAt = ExpressionAttributeValues[':revokedAt'];
            existing.updatedAt = ExpressionAttributeValues[':updatedAt'];
          }
        }
      }
    }

    return Promise.resolve({});
  }),
}));

// Mock the DynamoDB client - use a single mockSend that can be controlled
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => params),
  TransactWriteCommand: jest.fn((params) => params),
}));

describe('Integration: Agent Management Flow', () => {
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';
  const validDid2 = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY';

  beforeEach(() => {
    // Clear all DynamoDB state before each test
    dynamoDBState.agents.clear();
    dynamoDBState.didUniqueness.clear();
    dynamoDBState.refreshTokens.clear();
    dynamoDBState.nonces.clear();

    // Setup environment variables
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.NONCE_TABLE_NAME = 'test-nonce-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full agent lifecycle with shared state', () => {
    it('should handle complete register -> rotate -> revoke flow', async () => {
      // Step 1: Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      const registerResult = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(registerResult.statusCode).toBe(201);
      const registerBody = JSON.parse(registerResult.body);
      expect(registerBody.message).toBe('Agent registered successfully');

      // Verify agent stored in shared state
      const storedAgent = dynamoDBState.agents.get(validDid) as Record<string, unknown>;
      expect(storedAgent).toBeDefined();
      expect(storedAgent.status).toBe('active');

      // Step 2: Rotate key
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      const rotateResult = await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);
      expect(rotateResult.statusCode).toBe(200);
      const rotateBody = JSON.parse(rotateResult.body);
      expect(rotateBody.message).toBe('Key rotated successfully');

      // Verify old agent revoked
      const oldAgent = dynamoDBState.agents.get(validDid) as Record<string, unknown>;
      expect(oldAgent.status).toBe('revoked');

      // Verify new agent active
      const newAgent = dynamoDBState.agents.get(validDid2) as Record<string, unknown>;
      expect(newAgent.status).toBe('active');

      expect(dynamoDBState.agents.get(validDid)).toBeDefined();
      expect((dynamoDBState.agents.get(validDid) as Record<string, unknown>).status).toBe(
        'revoked'
      );
      expect(dynamoDBState.agents.get(validDid2)).toBeDefined();
      expect((dynamoDBState.agents.get(validDid2) as Record<string, unknown>).status).toBe(
        'active'
      );
    });

    it('should fail registration with duplicate DID', async () => {
      // First registration
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      const registerResult1 = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(registerResult1.statusCode).toBe(201);

      // Second registration with same DID
      const registerResult2 = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(registerResult2.statusCode).toBe(409);
      const registerBody2 = JSON.parse(registerResult2.body);
      expect(registerBody2.code).toBe('DUPLICATE_DID');
    });

    it('should fail rotation with revoked DID', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Revoke agent first
      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/agents/${validDid}`,
        httpMethod: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      };

      await revokeHandler(revokeEvent as APIGatewayProxyEvent);

      // Try to rotate revoked agent
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      const rotateResult = await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);
      expect(rotateResult.statusCode).toBe(400);
      const rotateBody = JSON.parse(rotateResult.body);
      expect(rotateBody.code).toBe('DID_REVOKED');
    });

    it('should fail rotation with duplicate new DID', async () => {
      // Register first agent
      const registerEvent1: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent 1' },
        }),
      };

      await registrationHandler(registerEvent1 as APIGatewayProxyEvent);

      // Register second agent
      const registerEvent2: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid2,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent 2' },
        }),
      };

      await registrationHandler(registerEvent2 as APIGatewayProxyEvent);

      // Try to rotate first agent to second agent's DID
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      const rotateResult = await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);
      expect(rotateResult.statusCode).toBe(409);
      const rotateBody = JSON.parse(rotateResult.body);
      expect(rotateBody.code).toBe('DUPLICATE_DID');
    });

    it('should fail revocation with non-existent DID', async () => {
      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/agents/${validDid}`,
        httpMethod: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      };

      const revokeResult = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(revokeResult.statusCode).toBe(404);
      const revokeBody = JSON.parse(revokeResult.body);
      expect(revokeBody.code).toBe('DID_NOT_FOUND');
    });

    it('should fail revocation with already revoked DID', async () => {
      // Register and revoke agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/agents/${validDid}`,
        httpMethod: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      };

      await revokeHandler(revokeEvent as APIGatewayProxyEvent);

      // Try to revoke again
      const revokeResult2 = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(revokeResult2.statusCode).toBe(400);
      const revokeBody2 = JSON.parse(revokeResult2.body);
      expect(revokeBody2.code).toBe('DID_REVOKED');
    });
  });

  describe('Agent state management', () => {
    it('should store agent with correct structure', async () => {
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      const storedAgent = dynamoDBState.agents.get(validDid) as Record<string, unknown>;
      expect(storedAgent).toMatchObject({
        did: validDid,
        status: 'active',
        publicKey: expect.any(String),
        metadata: { name: 'Test Agent' },
        didHistory: expect.any(Array),
        registeredAt: expect.any(String),
        updatedAt: expect.any(String),
        ttl: expect.any(Number),
      });
    });

    it('should update agent status on rotation', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Rotate key
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);

      // Verify old agent revoked
      const oldAgent = dynamoDBState.agents.get(validDid) as Record<string, unknown>;
      expect(oldAgent.status).toBe('revoked');
      expect(oldAgent.revokedAt).toBeDefined();

      // Verify new agent active
      const newAgent = dynamoDBState.agents.get(validDid2) as Record<string, unknown>;
      expect(newAgent.status).toBe('active');
      expect(newAgent.didHistory).toHaveLength(2);
    });

    it('should preserve metadata during rotation', async () => {
      const metadata = { name: 'Test Agent', version: '1.0' };

      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata,
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Rotate key
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);

      // Verify metadata preserved
      const newAgent = dynamoDBState.agents.get(validDid2) as Record<string, unknown>;
      expect(newAgent.metadata).toEqual(metadata);
    });
  });

  describe('DID uniqueness management', () => {
    it('should track DID uniqueness correctly', async () => {
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Verify DID uniqueness tracked
      const uniquenessEntry = dynamoDBState.didUniqueness.get(validDid) as Record<string, unknown>;
      expect(uniquenessEntry).toBeDefined();
      expect(uniquenessEntry.did).toBe(validDid);
      expect(uniquenessEntry.userId).toBeDefined();
    });

    it('should prevent duplicate DID in uniqueness table', async () => {
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Try to register again (should fail)
      const result = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(409);
    });
  });

  describe('Nonce management', () => {
    it('should track nonces correctly', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Rotate key
      const nonce = 'test-nonce-1';
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce,
        }),
      };

      await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);

      // Verify nonce tracked
      const storedNonce = dynamoDBState.nonces.get(nonce) as Record<string, unknown>;
      expect(storedNonce).toBeDefined();
      expect(storedNonce.nonce).toBe(nonce);
    });

    it('should reject reused nonce', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // First rotation
      const nonce = 'test-nonce-1';
      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce,
        }),
      };

      await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);

      // Second rotation with same nonce (should fail)
      const rotateEvent2: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ2',
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce,
        }),
      };

      const result = await rotateKeyHandler(rotateEvent2 as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('REUSED_NONCE');
    });
  });

  describe('Refresh token cleanup', () => {
    it('should delete all refresh tokens for user on revoke', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      const registerResult = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      const registerBody = JSON.parse(registerResult.body);

      // Store multiple refresh tokens
      dynamoDBState.refreshTokens.set('token-1', {
        token: 'token-1',
        userId: registerBody.userId || 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      dynamoDBState.refreshTokens.set('token-2', {
        token: 'token-2',
        userId: registerBody.userId || 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      dynamoDBState.refreshTokens.set('token-3', {
        token: 'token-3',
        userId: 'another-user-id',
        did: validDid2,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      // Revoke agent
      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/agents/${validDid}`,
        httpMethod: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      };

      await revokeHandler(revokeEvent as APIGatewayProxyEvent);

      // Verify only tokens for revoked user are deleted
      expect(dynamoDBState.refreshTokens.has('token-1')).toBe(false);
      expect(dynamoDBState.refreshTokens.has('token-2')).toBe(false);
      expect(dynamoDBState.refreshTokens.has('token-3')).toBe(true);
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors in registration', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB Error'));

      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      const result = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('should handle DynamoDB errors in rotation', async () => {
      // Register agent first
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Mock DynamoDB error
      mockSend.mockRejectedValueOnce(new Error('DynamoDB Error'));

      const rotateEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/rotate-key',
        httpMethod: 'POST',
        body: JSON.stringify({
          oldDid: validDid,
          newDid: validDid2,
          signature: 'valid-signature',
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'test-nonce-1',
        }),
      };

      const result = await rotateKeyHandler(rotateEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('should handle DynamoDB errors in revocation', async () => {
      // Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      await registrationHandler(registerEvent as APIGatewayProxyEvent);

      // Mock DynamoDB error
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/agents/${validDid}`,
        httpMethod: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      };

      const result = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
