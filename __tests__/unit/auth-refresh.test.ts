process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.JWT_PRIVATE_KEY = 'test-private-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../functions/auth-refresh/src/index';

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

    // Default mockSend returns empty object
    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /auth/refresh', async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: {
            token: validBody.refresh_token,
            userId: 'test-user-id',
            did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            isRevoked: false,
          },
        })
        .mockResolvedValueOnce({
          Items: [
            {
              userId: 'test-user-id',
              did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
              status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({});

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
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should return 401 for revoked refresh token', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          token: validBody.refresh_token,
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          isRevoked: true,
        },
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should return 401 for expired refresh token', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          token: validBody.refresh_token,
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          expiresAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          isRevoked: false,
        },
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('DID status check', () => {
    it('should return 401 for revoked DID', async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: {
            token: validBody.refresh_token,
            userId: 'test-user-id',
            did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            isRevoked: false,
          },
        })
        .mockResolvedValueOnce({
          Items: [],
        });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Error handling', () => {
    it('should return 500 on DynamoDB error', async () => {
      mockSend.mockRejectedValueOnce(new Error('DB Error'));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
