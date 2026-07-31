process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { handler } from '../src/index';

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
    
    mockSend.mockResolvedValue({});
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
      mockSend.mockImplementation((command: unknown) => {
        const cmd = command as { TableName: string; Key: Record<string, unknown> };
        if (cmd.TableName === 'test-token-blacklist-table') {
          return Promise.resolve({
            Item: {
              jti: 'test-jti-123',
              did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
              userId: 'test-user-id',
              revokedAt: new Date().toISOString(),
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return allow policy for non-blacklisted token', async () => {
      mockSend.mockImplementation((command: unknown) => {
        const cmd = command as { TableName: string; Key: Record<string, unknown> };
        if (cmd.TableName === 'test-token-blacklist-table') {
          return Promise.resolve({ Item: undefined });
        }
        return Promise.resolve({ Item: undefined });
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    });
  });

  describe('DynamoDB query behavior', () => {
    it('should query blacklist with correct parameters', async () => {
      await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should return deny policy on DynamoDB error', async () => {
      mockSend.mockRejectedValueOnce(new Error('DB Error'));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
