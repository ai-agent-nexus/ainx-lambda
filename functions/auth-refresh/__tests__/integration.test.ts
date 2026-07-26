process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.JWT_PRIVATE_KEY = 'test-private-key';

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

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
}));

// Track DynamoDB state for integration tests
const dynamoDBState = {
  refreshTokens: new Map<string, unknown>(),
  agents: new Map<string, unknown>(),
};

const mockGetFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('refresh-token')) {
    const token = key.token as string;
    const item = dynamoDBState.refreshTokens.get(token);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  if (tableName.includes('agent-registration')) {
    const did = key.did as string;
    const item = dynamoDBState.agents.get(did);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  return {
    promise: jest.fn().mockResolvedValue({ Item: undefined }),
  };
});

const mockTransactWriteFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TransactItems: Array<{
      Put?: { TableName: string; Item: Record<string, unknown> };
      Delete?: { TableName: string; Key: Record<string, unknown> };
    }>;
  };

  for (const item of params.TransactItems) {
    if (item.Put) {
      const tableName = item.Put.TableName;
      const itemData = item.Put.Item;
      if (tableName.includes('refresh-token')) {
        const token = itemData.token as string;
        dynamoDBState.refreshTokens.set(token, itemData);
      }
    }

    if (item.Delete) {
      const tableName = item.Delete.TableName;
      const key = item.Delete.Key;
      if (tableName.includes('refresh-token')) {
        const token = key.token as string;
        dynamoDBState.refreshTokens.delete(token);
      }
    }
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (_params: unknown) => mockGetFn(_params),
      transactWrite: (_params: unknown) => mockTransactWriteFn(_params),
    })),
  },
}));

describe('Integration: auth-refresh handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    refresh_token: 'test-refresh-token-123',
  };

  beforeEach(() => {
    mockEvent = {
      path: '/auth/refresh',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.JWT_PRIVATE_KEY = 'test-private-key';

    dynamoDBState.refreshTokens.clear();
    dynamoDBState.agents.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full refresh flow', () => {
    it('should handle complete token refresh flow', async () => {
      // Setup: Store refresh token
      dynamoDBState.refreshTokens.set(validBody.refresh_token, {
        token: validBody.refresh_token,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        isRevoked: false,
      });

      // Setup: Store agent
      dynamoDBState.agents.set('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ', {
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBe('mock-jwt-token');
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBe(3600);
      expect(body.token_type).toBe('Bearer');

      // Verify old refresh token deleted
      expect(dynamoDBState.refreshTokens.has(validBody.refresh_token)).toBe(false);

      // Verify new refresh token stored
      const newRefreshToken = body.refresh_token;
      expect(dynamoDBState.refreshTokens.has(newRefreshToken)).toBe(true);
      const storedToken = dynamoDBState.refreshTokens.get(newRefreshToken) as Record<
        string,
        unknown
      >;
      expect(storedToken.userId).toBe('test-user-id');
      expect(storedToken.did).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(storedToken.isRevoked).toBe(false);
    });

    it('should fail with invalid refresh token', async () => {
      // No refresh token stored

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should fail with revoked refresh token', async () => {
      // Setup: Store revoked refresh token
      dynamoDBState.refreshTokens.set(validBody.refresh_token, {
        token: validBody.refresh_token,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        isRevoked: true,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should fail with expired refresh token', async () => {
      // Setup: Store expired refresh token
      dynamoDBState.refreshTokens.set(validBody.refresh_token, {
        token: validBody.refresh_token,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
        isRevoked: false,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should fail with revoked DID', async () => {
      // Setup: Store refresh token
      dynamoDBState.refreshTokens.set(validBody.refresh_token, {
        token: validBody.refresh_token,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        isRevoked: false,
      });

      // Setup: Store revoked agent
      dynamoDBState.agents.set('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ', {
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        status: 'revoked',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Token rotation', () => {
    it('should generate unique refresh tokens on each refresh', async () => {
      // Setup: Store refresh token
      dynamoDBState.refreshTokens.set(validBody.refresh_token, {
        token: validBody.refresh_token,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        isRevoked: false,
      });

      // Setup: Store agent
      dynamoDBState.agents.set('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ', {
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result1 = await handler(mockEvent as APIGatewayProxyEvent);
      const body1 = JSON.parse(result1.body);
      const firstRefreshToken = body1.refresh_token;

      // Setup: Store new refresh token for second refresh
      dynamoDBState.refreshTokens.set(firstRefreshToken, {
        token: firstRefreshToken,
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        isRevoked: false,
      });

      mockEvent.body = JSON.stringify({
        refresh_token: firstRefreshToken,
      });

      const result2 = await handler(mockEvent as APIGatewayProxyEvent);
      const body2 = JSON.parse(result2.body);

      expect(body1.refresh_token).not.toBe(body2.refresh_token);
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
