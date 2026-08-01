import { handler } from '../src/index';
import { APIGatewayProxyEvent } from 'aws-lambda';

process.env.CONNECTIONS_TABLE_NAME = 'test-connections';
process.env.MESSAGES_TABLE_NAME = 'test-messages';

jest.mock('@ainx/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({
      send: jest.fn(),
    }),
  },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  QueryCommand: jest.fn(),
}));

describe('connection-message-send', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEvent = {
      path: '/connections/did:key:receiver/messages',
      httpMethod: 'POST',
      body: JSON.stringify({ content: 'Hello, world!' }),
      requestContext: {
        authorizer: {
          did: 'did:key:sender',
        },
      } as any,
      headers: {},
    };

    // Setup environment variables
    process.env.CONNECTIONS_TABLE_NAME = 'test-connections';
    process.env.MESSAGES_TABLE_NAME = 'test-messages';

    // Get mock DynamoDB instance
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    mockDynamoDB = DynamoDBDocumentClient.from();
  });

  it('should send message successfully', async () => {
    // Mock connection exists
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        userId: 'did:key:sender',
        connectionId: 'did:key:receiver',
        status: 'CONNECTED',
      },
    });

    // Mock no duplicate message
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    // Mock put message
    mockDynamoDB.send.mockResolvedValueOnce({});

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.messageId).toBeDefined();
  });

  it('should return 404 for invalid path', async () => {
    mockEvent.path = '/invalid/path';

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(404);
  });

  it('should return 401 for missing DID', async () => {
    mockEvent.requestContext = {} as any;

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(401);
  });

  it('should return 400 for invalid body', async () => {
    mockEvent.body = 'invalid-json';

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
  });

  it('should return 400 for empty content', async () => {
    mockEvent.body = JSON.stringify({ content: '' });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
  });

  it('should return 403 for unauthorized connection', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: null,
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(403);
  });

  it('should handle duplicate message (idempotency)', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        userId: 'did:key:sender',
        connectionId: 'did:key:receiver',
        status: 'CONNECTED',
      },
    });

    // Mock duplicate message exists
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          messageId: 'msg_existing123',
          messageIdempotencyKey: 'test-key',
        },
      ],
    });

    mockEvent.headers = { 'x-idempotency-key': 'test-key' };

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.messageId).toBe('msg_existing123');
  });
});
