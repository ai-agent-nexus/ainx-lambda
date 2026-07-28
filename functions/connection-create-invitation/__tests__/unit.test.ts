process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
process.env.CONNECTION_REQUESTS_TABLE_NAME = 'test-connection-requests-table';
process.env.INVITATIONS_TABLE_NAME = 'test-invitations-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';

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

jest.mock('@ainx/connection-utils', () => ({
  generateInvitationCode: jest.fn(() => '550e8400-e29b-41d4-a716-446655440000'),
  calculateInvitationExpiration: jest.fn(() => ({
    expiresAt: '2026-07-28T13:30:00Z',
    ttl: 1753708200,
  })),
  isValidInvitationCode: jest.fn(() => true),
  MAX_INVITATION_TTL_SECONDS: 86400,
}));

const mockPutFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (...args: unknown[]) => (mockPutFn as jest.Mock)(...args),
    })),
  },
}));

describe('create-invitation handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/connections/invitations',
      httpMethod: 'POST',
      body: JSON.stringify({}),
      requestContext: {
        authorizer: {
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        },
      } as any,
    };
    process.env.INVITATIONS_TABLE_NAME = 'test-invitations-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /connections/invitations', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.invitationCode).toBeDefined();
    });

    it('should return 404 for unknown routes', async () => {
      mockEvent.path = '/connections/unknown';

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

    it('should return 400 for expiration exceeding maximum', async () => {
      mockEvent.body = JSON.stringify({ expiresInSeconds: 100000 });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_EXPIRATION');
    });

    it('should return 400 for negative expiration', async () => {
      mockEvent.body = JSON.stringify({ expiresInSeconds: -100 });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_EXPIRATION');
    });
  });

  describe('Authentication', () => {
    it('should return 401 for missing DID', async () => {
      mockEvent.requestContext = {
        authorizer: {},
      } as any;

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Invitation creation', () => {
    it('should create invitation with default expiration', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.invitationCode).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(body.expiresAt).toBe('2026-07-28T13:30:00Z');
      expect(mockPutFn).toHaveBeenCalled();
    });

    it('should create invitation with custom expiration', async () => {
      mockEvent.body = JSON.stringify({ expiresInSeconds: 3600 });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.invitationCode).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should return 500 for unexpected errors', async () => {
      mockPutFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
