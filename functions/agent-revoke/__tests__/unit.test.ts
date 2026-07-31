process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';

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

    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle DELETE /agents/{did}', async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: {
            userId: 'test-user-id',
            did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            status: 'active',
          },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Agent revoked successfully');
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
  });

  describe('DID validation', () => {
    it('should return 404 for non-existent DID', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should return 400 for already revoked DID', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: 'test-user-id',
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
          status: 'revoked',
        },
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_REVOKED');
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
