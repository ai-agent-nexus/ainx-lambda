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

const mockQueryFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({ Items: [], Count: 0 }),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (...args: unknown[]) => (mockQueryFn as jest.Mock)(...args),
    })),
  },
}));

describe('list-connections handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/connections',
      httpMethod: 'GET',
      requestContext: {
        authorizer: {
          did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        },
      } as any,
      queryStringParameters: {},
    };
    process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle GET /connections', async () => {
      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              connectionId: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_other',
              status: 'CONNECTED',
              createdAt: '2026-07-28T13:00:00Z',
            },
          ],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].status).toBe('CONNECTED');
    });

    it('should return 404 for unknown routes', async () => {
      mockEvent.path = '/connections/unknown';

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

  describe('Pagination', () => {
    it('should handle limit parameter', async () => {
      mockEvent.queryStringParameters = { limit: '10' };

      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 10,
        })
      );
    });

    it('should handle nextToken parameter', async () => {
      mockEvent.queryStringParameters = {
        nextToken: Buffer.from(JSON.stringify({ userId: 'test', connectionId: 'test' })).toString('base64'),
      };

      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          ExclusiveStartKey: { userId: 'test', connectionId: 'test' },
        })
      );
    });

    it('should return nextToken when more results exist', async () => {
      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [],
          LastEvaluatedKey: { userId: 'test', connectionId: 'test' },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.nextToken).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should return 500 for unexpected errors', async () => {
      mockQueryFn.mockImplementation(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
