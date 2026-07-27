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

const mockQueryFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Items: [] }),
}));

const mockGetFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Item: undefined }),
}));

const mockTransactWriteFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
      transactWrite: (...args: unknown[]) => (mockTransactWriteFn as jest.Mock)(...args),
      query: (...args: unknown[]) => (mockQueryFn as jest.Mock)(...args),
    })),
  },
}));

describe('auth-refresh handler', () => {
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

    mockGetFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    }));
    mockQueryFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    }));
    mockTransactWriteFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /auth/refresh', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: false,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [
                {
                  userId: 'test-user-id',
                  did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                  status: 'active',
                },
              ],
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Items: [] }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBeDefined();
      expect(body.token_type).toBe('Bearer');
    });

    it('should return 404 for unknown routes', async () => {
      mockEvent.path = '/auth/unknown';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('Request validation', () => {
    it('should return 400 for invalid request body', async () => {
      mockEvent.body = 'not-json';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_BODY');
    });

    it('should return 400 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({});

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });
  });

  describe('Refresh token validation', () => {
    it('should return 401 for non-existent refresh token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({ Item: undefined }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should return 401 for revoked refresh token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: true,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should return 401 for expired refresh token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
                expiresAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: false,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('DID status check', () => {
    it('should return 401 for revoked DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: false,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [],
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Items: [] }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should return 401 for non-existent DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: false,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [],
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Items: [] }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Token generation', () => {
    it('should generate new token pair and delete old refresh token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-refresh-token-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                token: validBody.refresh_token,
                userId: 'test-user-id',
                did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isRevoked: false,
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string };
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [
                {
                  userId: 'test-user-id',
                  did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
                  status: 'active',
                },
              ],
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Items: [] }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBe('mock-jwt-token');
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBe(3600);
      expect(body.token_type).toBe('Bearer');

      // Verify old refresh token is deleted
      expect(mockTransactWriteFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TransactItems: expect.arrayContaining([
            expect.objectContaining({
              Delete: expect.objectContaining({
                TableName: 'test-refresh-token-table',
                Key: { token: validBody.refresh_token },
              }),
            }),
          ]),
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
