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
  ConnectionStatus: {
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    BLOCKED: 'BLOCKED',
  },
}));

const mockGetFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

const mockTransactWriteFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
      transactWrite: (...args: unknown[]) => (mockTransactWriteFn as jest.Mock)(...args),
    })),
  },
}));

describe('remove-connection handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/connections/did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
      httpMethod: 'DELETE',
      requestContext: {
        authorizer: {
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        },
      } as any,
    };
    process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle DELETE /connections/{connectionId}', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'CONNECTED',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('DISCONNECTED');
      expect(body.message).toBe('Connection removed successfully');
    });

    it('should return 404 for unknown routes', async () => {
      mockEvent.path = '/connections';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('should return 404 for non-DELETE methods', async () => {
      mockEvent.httpMethod = 'POST';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
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

  describe('Connection validation', () => {
    it('should return 404 for non-existent connection', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({}),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('CONNECTION_NOT_FOUND');
    });

    it('should return 400 for non-active connection', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'DISCONNECTED',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('CONNECTION_NOT_ACTIVE');
    });

    it('should return 400 for blocked connection', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'BLOCKED',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('CONNECTION_NOT_ACTIVE');
    });
  });

  describe('Transaction', () => {
    it('should update both directions with transactWrite', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'CONNECTED',
          },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      expect(mockTransactWriteFn).toHaveBeenCalled();
      const transactParams = (mockTransactWriteFn.mock.calls[0] as unknown[])[0] as {
        TransactItems: Array<{ Update: { Key: Record<string, string> } }>;
      };
      expect(transactParams.TransactItems).toHaveLength(2);

      // Check first update (user -> connection)
      expect(transactParams.TransactItems[0].Update.Key).toEqual({
        userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
      });

      // Check second update (connection -> user, reversed)
      expect(transactParams.TransactItems[1].Update.Key).toEqual({
        userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
        connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
      });
    });

    it('should return 500 when transactWrite fails', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: {
            userId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
            status: 'CONNECTED',
          },
        }),
      }));

      mockTransactWriteFn.mockImplementation(() => ({
        promise: jest.fn().mockRejectedValue(new Error('Transaction failed')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
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
