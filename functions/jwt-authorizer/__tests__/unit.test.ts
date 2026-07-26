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

const mockGetFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Item: undefined }),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
    })),
  },
}));

describe('jwt-authorizer handler', () => {
  let mockEvent: Partial<APIGatewayTokenAuthorizerEvent>;

  beforeEach(() => {
    mockEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abc123/sit/GET/agents',
      authorizationToken: 'valid-jwt-token',
    };
    process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';

    mockGetFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Token validation', () => {
    it('should return allow policy for valid token', async () => {
      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
      expect(result.context).toEqual({
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        userId: 'test-user-id',
      });
    });

    it('should return deny policy for missing token', async () => {
      mockEvent.authorizationToken = undefined;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for expired token', async () => {
      const { verify } = await import('jsonwebtoken');
      (verify as jest.Mock).mockImplementationOnce(() => {
        throw new (jest.requireMock('jsonwebtoken').TokenExpiredError)();
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for invalid token', async () => {
      const { verify } = await import('jsonwebtoken');
      (verify as jest.Mock).mockImplementationOnce(() => {
        throw new (jest.requireMock('jsonwebtoken').JsonWebTokenError)('invalid signature');
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('Blacklist check', () => {
    it('should return deny policy for blacklisted token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-token-blacklist-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                jti: 'test-jti-123',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                userId: 'test-user-id',
                revokedAt: new Date().toISOString(),
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return allow policy for non-blacklisted token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-token-blacklist-table') {
          return {
            promise: jest.fn().mockResolvedValue({ Item: undefined }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    });
  });

  describe('DynamoDB query behavior', () => {
    it('should query blacklist with correct parameters', async () => {
      await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(mockGetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-token-blacklist-table',
          Key: { jti: 'test-jti-123' },
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return deny policy on DynamoDB error', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
