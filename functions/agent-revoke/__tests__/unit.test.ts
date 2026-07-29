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

const mockGetFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Item: undefined }),
}));

const mockUpdateFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

const mockQueryFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Items: [] }),
}));

const mockDeleteFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
      update: (...args: unknown[]) => (mockUpdateFn as jest.Mock)(...args),
      query: (...args: unknown[]) => (mockQueryFn as jest.Mock)(...args),
      delete: (...args: unknown[]) => (mockDeleteFn as jest.Mock)(...args),
    })),
  },
}));

describe('agent-revoke handler', () => {
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

    mockGetFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    }));
    mockUpdateFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
    mockQueryFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    }));
    mockDeleteFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle DELETE /agents/{did}', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                status: 'active',
                publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
                metadata: { name: 'Test Agent' },
                didHistory: [],
                registeredAt: new Date().toISOString(),
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Agent revoked successfully');
      expect(body.did).toBe('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ');
      expect(body.revokedAt).toBeDefined();
    });

    it('should return 404 for non-DELETE methods', async () => {
      mockEvent.httpMethod = 'GET';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('should return 404 for invalid path', async () => {
      mockEvent.path = '/agents';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('Authorization', () => {
    it('should return 401 for missing Authorization header', async () => {
      mockEvent.headers = {};

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_TOKEN');
    });

    it('should return 401 for invalid token', async () => {
      const { verify } = await import('jsonwebtoken');
      (verify as jest.Mock).mockImplementationOnce(() => {
        throw new (jest.requireMock('jsonwebtoken').JsonWebTokenError)('invalid signature');
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_TOKEN');
    });

    it('should return 403 for unauthorized DID', async () => {
      // Token has different DID
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

  describe('DID validation', () => {
    it('should return 404 for non-existent DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({ Item: undefined }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should return 400 for already revoked DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                status: 'revoked',
                publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
                metadata: { name: 'Test Agent' },
                didHistory: [],
                registeredAt: new Date().toISOString(),
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_REVOKED');
    });
  });

  describe('Revocation process', () => {
    it('should update agent status to revoked', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                status: 'active',
                publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
                metadata: { name: 'Test Agent' },
                didHistory: [],
                registeredAt: new Date().toISOString(),
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(mockUpdateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-agent-registration-table',
          Key: {
            userId: 'test-user-id',
            did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          },
          UpdateExpression: 'SET #status = :status, revokedAt = :revokedAt, updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': 'revoked',
            ':revokedAt': expect.any(String),
            ':updatedAt': expect.any(String),
          },
        })
      );
    });

    it('should delete refresh tokens', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                status: 'active',
                publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
                metadata: { name: 'Test Agent' },
                didHistory: [],
                registeredAt: new Date().toISOString(),
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [
                { token: 'refresh-token-1', userId: 'test-user-id' },
                { token: 'refresh-token-2', userId: 'test-user-id' },
              ],
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Items: [] }) };
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(mockDeleteFn).toHaveBeenCalledTimes(2);
      expect(mockDeleteFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-refresh-token-table',
          Key: { token: 'refresh-token-1' },
        })
      );
      expect(mockDeleteFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-refresh-token-table',
          Key: { token: 'refresh-token-2' },
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return 500 on DynamoDB error', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
