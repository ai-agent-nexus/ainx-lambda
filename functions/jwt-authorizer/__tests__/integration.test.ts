process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { handler } from '../src/index';

// Mock dependencies
jest.mock('@ainx/logger');

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
};

const mockGetFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('blacklist')) {
    const jti = key.jti as string;
    const item = dynamoDBState.blacklist.get(jti);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  return {
    promise: jest.fn().mockResolvedValue({ Item: undefined }),
  };
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (_params: unknown) => mockGetFn(_params),
    })),
  },
}));

describe('Integration: jwt-authorizer handler', () => {
  let mockEvent: Partial<APIGatewayTokenAuthorizerEvent>;

  beforeEach(() => {
    mockEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abc123/sit/GET/agents',
      authorizationToken: 'valid-jwt-token',
    };
    process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';

    dynamoDBState.blacklist.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full authorization flow', () => {
    it('should handle complete authorization flow', async () => {
      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
      expect(result.context).toEqual({
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        userId: 'test-user-id',
      });
    });

    it('should deny blacklisted token', async () => {
      // Setup: Add token to blacklist
      dynamoDBState.blacklist.set('test-jti-123', {
        jti: 'test-jti-123',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        userId: 'test-user-id',
        revokedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should allow non-blacklisted token', async () => {
      // No tokens in blacklist

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    });
  });

  describe('DynamoDB state management', () => {
    it('should query blacklist with correct JTI', async () => {
      await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(mockGetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-token-blacklist-table',
          Key: { jti: 'test-jti-123' },
        })
      );
    });

    it('should handle multiple tokens', async () => {
      // First token
      const result1 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result1.policyDocument.Statement[0].Effect).toBe('Allow');

      // Blacklist first token
      dynamoDBState.blacklist.set('test-jti-123', {
        jti: 'test-jti-123',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        userId: 'test-user-id',
        revokedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });

      // First token should now be denied
      const result2 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result2.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
