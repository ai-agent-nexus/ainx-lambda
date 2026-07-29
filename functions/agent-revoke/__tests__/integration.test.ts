process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';

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
  refreshTokens: new Map<string, unknown>(),
};

const mockGetFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('agent-registration')) {
    const did = key.did as string;
    const userId = key.userId as string;
    const item = dynamoDBState.agents.get(`${userId}:${did}`);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  return {
    promise: jest.fn().mockResolvedValue({ Item: undefined }),
  };
});

const mockUpdateFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('agent-registration')) {
    const did = key.did as string;
    const userId = key.userId as string;
    const existing = dynamoDBState.agents.get(`${userId}:${did}`) as Record<string, unknown>;
    if (existing) {
      existing.status = params.ExpressionAttributeValues[':status'];
      existing.revokedAt = params.ExpressionAttributeValues[':revokedAt'];
      existing.updatedAt = params.ExpressionAttributeValues[':updatedAt'];
    }
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

const mockQueryFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  const tableName = params.TableName;
  const userId = params.ExpressionAttributeValues?.[':userId'] as string;

  if (tableName.includes('refresh-token')) {
    const tokens: Array<Record<string, unknown>> = [];
    for (const [, item] of dynamoDBState.refreshTokens) {
      const tokenItem = item as Record<string, unknown>;
      if (!userId || tokenItem.userId === userId) {
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
});

const mockDeleteFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('refresh-token')) {
    const token = key.token as string;
    dynamoDBState.refreshTokens.delete(token);
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (_params: unknown) => mockGetFn(_params),
      update: (_params: unknown) => mockUpdateFn(_params),
      query: (_params: unknown) => mockQueryFn(_params),
      delete: (_params: unknown) => mockDeleteFn(_params),
    })),
  },
}));

describe('Integration: agent-revoke handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/agents/did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
      httpMethod: 'DELETE',
      headers: {
        Authorization: 'Bearer valid-jwt-token',
      },
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';

    dynamoDBState.agents.clear();
    dynamoDBState.refreshTokens.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full revocation flow', () => {
    it('should handle complete agent revocation flow', async () => {
      // Setup: Store active agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
        }
      );

      // Setup: Store refresh tokens
      dynamoDBState.refreshTokens.set('refresh-token-1', {
        token: 'refresh-token-1',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      dynamoDBState.refreshTokens.set('refresh-token-2', {
        token: 'refresh-token-2',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Agent revoked successfully');
      expect(body.did).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(body.revokedAt).toBeDefined();

      // Verify agent status updated
      const agent = dynamoDBState.agents.get(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ'
      ) as Record<string, unknown>;
      expect(agent.status).toBe('revoked');
      expect(agent.revokedAt).toBeDefined();

      // Verify refresh tokens deleted
      expect(dynamoDBState.refreshTokens.size).toBe(0);
    });

    it('should fail with non-existent DID', async () => {
      // No agent stored

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should fail with already revoked DID', async () => {
      // Setup: Store revoked agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'revoked',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
          revokedAt: new Date().toISOString(),
        }
      );

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_REVOKED');
    });

    it('should fail with unauthorized DID', async () => {
      // Setup: Store active agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
        }
      );

      // Mock JWT with different DID
      const { verify } = await import('jsonwebtoken');
      (verify as jest.Mock).mockReturnValueOnce({
        sub: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'ainx-api',
        jti: 'test-jti-123',
        scope: 'agent:read agent:write',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  describe('Agent state management', () => {
    it('should update agent status correctly', async () => {
      // Setup: Store active agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
        }
      );

      await handler(mockEvent as APIGatewayProxyEvent);

      const agent = dynamoDBState.agents.get(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ'
      ) as Record<string, unknown>;
      expect(agent.status).toBe('revoked');
      expect(agent.revokedAt).toBeDefined();
      expect(agent.updatedAt).toBeDefined();
    });

    it('should preserve other agent data', async () => {
      // Setup: Store active agent with metadata
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent', version: '1.0' },
          didHistory: [{ did: 'did:key:original', revokedAt: null, reason: null }],
          registeredAt: '2024-01-01T00:00:00Z',
        }
      );

      await handler(mockEvent as APIGatewayProxyEvent);

      const agent = dynamoDBState.agents.get(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ'
      ) as Record<string, unknown>;
      expect(agent.metadata).toEqual({ name: 'Test Agent', version: '1.0' });
      expect(agent.didHistory).toHaveLength(1);
      expect(agent.registeredAt).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('Refresh token cleanup', () => {
    it('should delete all refresh tokens for user', async () => {
      // Setup: Store active agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
        }
      );

      // Setup: Store multiple refresh tokens
      dynamoDBState.refreshTokens.set('token-1', {
        token: 'token-1',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      dynamoDBState.refreshTokens.set('token-2', {
        token: 'token-2',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      dynamoDBState.refreshTokens.set('token-3', {
        token: 'token-3',
        userId: 'another-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      // Verify only tokens for the revoked user are deleted
      expect(dynamoDBState.refreshTokens.has('token-1')).toBe(false);
      expect(dynamoDBState.refreshTokens.has('token-2')).toBe(false);
      expect(dynamoDBState.refreshTokens.has('token-3')).toBe(true);
    });

    it('should handle no refresh tokens gracefully', async () => {
      // Setup: Store active agent
      dynamoDBState.agents.set(
        'test-user-id:did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'active',
          publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: new Date().toISOString(),
        }
      );

      // No refresh tokens stored

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Agent revoked successfully');
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
