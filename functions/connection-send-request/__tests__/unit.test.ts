process.env.CONNECTION_REQUESTS_TABLE_NAME = 'test-connection-requests-table';
process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
process.env.INVITATIONS_TABLE_NAME = 'test-invitations-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';

import { APIGatewayProxyEvent } from 'aws-lambda';

// State for controlling mock behavior
let invitationResponse: Record<string, unknown> = {
  Item: {
    invitationCode: '550e8400-e29b-41d4-a716-446655440000',
    expiresAt: '2099-01-01T00:00:00Z',
    ttl: 4102444800,
  },
};
let agentResponse: Record<string, unknown> = {
  Items: [{ did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ', status: 'active' }],
};
let shouldThrowError = false;

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
  isValidDid: jest.fn((did: string) => did.startsWith('did:key:')),
  isValidInvitationCode: jest.fn(() => true),
  isInvitationExpired: jest.fn((expiresAt: string) => new Date(expiresAt) < new Date()),
  generateRequestId: jest.fn(() => 'req_test123'),
  CONNECTION_LIMIT: 100,
  ConnectionRequestStatus: {
    PENDING: 'PENDING',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
  },
}));

// Mock the DynamoDB client - use a single mockSend that can be controlled
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: unknown[]) => {
        const command = args[0] as { TableName: string; Key?: Record<string, unknown> };
        if (command.TableName === 'test-invitations-table') {
          return Promise.resolve(invitationResponse);
        }
        if (command.TableName === 'test-agent-registration-table') {
          return Promise.resolve(agentResponse);
        }
        if (shouldThrowError) {
          return Promise.reject(new Error('DB Error'));
        }
        return Promise.resolve({});
      },
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => params),
  TransactWriteCommand: jest.fn((params) => params),
}));

// Import handler AFTER all mocks
import { handler } from '../src/index';

describe('send-request handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    invitationCode: '550e8400-e29b-41d4-a716-446655440000',
  };

  beforeEach(() => {
    mockEvent = {
      path: '/connections/requests',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
      requestContext: {
        authorizer: {
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
        },
      } as any,
    };
    // Reset mock state
    invitationResponse = {
      Item: {
        invitationCode: validBody.invitationCode,
        expiresAt: '2099-01-01T00:00:00Z',
        ttl: 4102444800,
      },
    };
    agentResponse = {
      Items: [{ did: validBody.toDid, status: 'active' }],
    };
    shouldThrowError = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /connections/requests', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.requestId).toBe('req_test123');
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

    it('should return 400 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({ toDid: validBody.toDid });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });

    it('should return 400 for connecting to self', async () => {
      mockEvent.body = JSON.stringify({
        toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
        invitationCode: validBody.invitationCode,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('should return 400 for invalid DID format', async () => {
      mockEvent.body = JSON.stringify({
        toDid: 'invalid-did',
        invitationCode: validBody.invitationCode,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });
  });

  describe('Invitation validation', () => {
    it('should return 400 for expired invitation', async () => {
      invitationResponse = {
        Item: {
          invitationCode: validBody.invitationCode,
          expiresAt: '2020-01-01T00:00:00Z',
          ttl: 1577836800,
        },
      };

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('EXPIRED_INVITATION');
    });

    it('should return 400 for non-existent invitation', async () => {
      invitationResponse = {};

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_INVITATION');
    });
  });

  describe('Agent validation', () => {
    it('should return 400 for non-existent agent', async () => {
      agentResponse = { Items: [] };

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('AGENT_NOT_FOUND');
    });
  });

  describe('Error handling', () => {
    it('should return 500 for unexpected errors', async () => {
      shouldThrowError = true;

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
