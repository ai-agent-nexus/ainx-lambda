process.env.CONNECTION_REQUESTS_TABLE_NAME = 'test-connection-requests-table';
process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';

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

jest.mock('@ainx/connection-utils', () => ({
  CONNECTION_LIMIT: 100,
  ConnectionStatus: {
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    BLOCKED: 'BLOCKED',
  },
  ConnectionRequestStatus: {
    PENDING: 'PENDING',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
  },
}));

const mockGetFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

const mockQueryFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({ Items: [], Count: 0 }),
}));

const mockTransactWriteFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
      query: (...args: unknown[]) => (mockQueryFn as jest.Mock)(...args),
      transactWrite: (...args: unknown[]) => (mockTransactWriteFn as jest.Mock)(...args),
    })),
  },
}));

describe('accept-request handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/connections/requests/req_test123/accept',
      httpMethod: 'POST',
      requestContext: {
        authorizer: {
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        },
      } as any,
    };
    process.env.CONNECTION_REQUESTS_TABLE_NAME = 'test-connection-requests-table';
    process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /connections/requests/{id}/accept', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            requestId: 'req_test123',
            fromDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
            toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            status: 'PENDING',
          },
        }),
      }));

      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({ Count: 0 }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('ACCEPTED');
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
    it('should return 404 for non-existent request', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({}),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('REQUEST_NOT_FOUND');
    });

    it('should return 403 for non-target user', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            requestId: 'req_test123',
            fromDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
            toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'PENDING',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('should return 409 for non-pending request', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            requestId: 'req_test123',
            fromDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
            toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            status: 'ACCEPTED',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('CONFLICT');
    });
  });

  describe('Connection limit', () => {
    it('should return 429 when connection limit reached', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            requestId: 'req_test123',
            fromDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender',
            toDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            status: 'PENDING',
          },
        }),
      }));

      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({ Count: 100 }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(429);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('TOO_MANY_CONNECTIONS');
    });
  });

  describe('Error handling', () => {
    it('should return 500 for unexpected errors', async () => {
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
