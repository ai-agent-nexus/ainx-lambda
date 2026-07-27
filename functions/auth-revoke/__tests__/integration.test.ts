process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
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
  validateInput: jest.fn(() => ({ valid: true, missingFields: [] })),
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
  blacklist: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
};

const mockPutFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Item: Record<string, unknown> };
  const tableName = params.TableName;
  const item = params.Item;

  if (tableName.includes('blacklist')) {
    const jti = item.jti as string;
    dynamoDBState.blacklist.set(jti, item);
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
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
      put: (_params: unknown) => mockPutFn(_params),
      delete: (_params: unknown) => mockDeleteFn(_params),
    })),
  },
}));

describe('Integration: auth-revoke handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/auth/revoke',
      httpMethod: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt-token',
      },
      body: JSON.stringify({
        refresh_token: 'test-refresh-token-123',
      }),
    };
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';

    dynamoDBState.blacklist.clear();
    dynamoDBState.refreshTokens.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full revocation flow', () => {
    it('should handle complete token revocation flow', async () => {
      // Setup: Store refresh token
      dynamoDBState.refreshTokens.set('test-refresh-token-123', {
        token: 'test-refresh-token-123',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Token revoked successfully');

      // Verify JTI added to blacklist
      expect(dynamoDBState.blacklist.has('test-jti-123')).toBe(true);
      const blacklistedItem = dynamoDBState.blacklist.get('test-jti-123') as Record<
        string,
        unknown
      >;
      expect(blacklistedItem.did).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(blacklistedItem.userId).toBe('test-user-id');
      expect(blacklistedItem.ttl).toBeDefined();

      // Verify refresh token deleted
      expect(dynamoDBState.refreshTokens.has('test-refresh-token-123')).toBe(false);
    });

    it('should revoke without refresh token', async () => {
      mockEvent.body = JSON.stringify({});

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Token revoked successfully');

      // Verify JTI added to blacklist
      expect(dynamoDBState.blacklist.has('test-jti-123')).toBe(true);
    });

    it('should handle multiple token revocations', async () => {
      const result1 = await handler(mockEvent as APIGatewayProxyEvent);
      expect(result1.statusCode).toBe(200);

      // Mock a different JTI for second revocation
      const { verify } = await import('jsonwebtoken');
      (verify as jest.Mock).mockReturnValueOnce({
        sub: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'ainx-api',
        jti: 'test-jti-456',
        scope: 'agent:read agent:write',
      });

      mockEvent.body = JSON.stringify({
        refresh_token: 'test-refresh-token-456',
      });

      const result2 = await handler(mockEvent as APIGatewayProxyEvent);
      expect(result2.statusCode).toBe(200);

      // Verify both JTIs are blacklisted
      expect(dynamoDBState.blacklist.has('test-jti-123')).toBe(true);
      expect(dynamoDBState.blacklist.has('test-jti-456')).toBe(true);
    });
  });

  describe('Blacklist management', () => {
    it('should store blacklist entry with correct structure', async () => {
      await handler(mockEvent as APIGatewayProxyEvent);

      const blacklistedItem = dynamoDBState.blacklist.get('test-jti-123') as Record<
        string,
        unknown
      >;
      expect(blacklistedItem).toMatchObject({
        jti: 'test-jti-123',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        userId: 'test-user-id',
        revokedAt: expect.any(String),
        ttl: expect.any(Number),
      });
    });

    it('should set correct TTL for blacklist entry', async () => {
      const beforeRequest = Math.floor(Date.now() / 1000);
      await handler(mockEvent as APIGatewayProxyEvent);
      const afterRequest = Math.floor(Date.now() / 1000);

      const blacklistedItem = dynamoDBState.blacklist.get('test-jti-123') as Record<
        string,
        unknown
      >;
      const ttl = blacklistedItem.ttl as number;

      expect(ttl).toBeGreaterThan(beforeRequest + 3300); // ~55 minutes
      expect(ttl).toBeLessThan(afterRequest + 3900); // ~65 minutes
    });
  });

  describe('Refresh token cleanup', () => {
    it('should delete refresh token after revocation', async () => {
      // Setup: Store refresh token
      dynamoDBState.refreshTokens.set('test-refresh-token-123', {
        token: 'test-refresh-token-123',
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(dynamoDBState.refreshTokens.has('test-refresh-token-123')).toBe(false);
    });

    it('should not fail if refresh token does not exist', async () => {
      // No refresh token stored

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Token revoked successfully');
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockPutFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
