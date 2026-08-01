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
  QueryCommand: jest.fn(),
}));

describe('connection-message-list', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  let mockDynamoDB: any;
  const testConnectionId = '550e8400-e29b-41d4-a716-446655440000';
  const testTargetDid = 'did:key:receiver';

  beforeEach(() => {
    jest.clearAllMocks();
    mockEvent = {
      path: `/connections/${testConnectionId}/messages`,
      httpMethod: 'GET',
      queryStringParameters: {},
      requestContext: {
        authorizer: {
          did: 'did:key:sender',
        },
      } as any,
    };

    const { DynamoDBDocumentClient } = jest.requireMock('@aws-sdk/lib-dynamodb');
    mockDynamoDB = DynamoDBDocumentClient.from();
  });

  it('should list messages successfully', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        userId: 'did:key:sender',
        connectionId: testConnectionId,
        targetDid: testTargetDid,
        status: 'CONNECTED',
      },
    });

    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          messageId: 'msg_001',
          connectionId: testConnectionId,
          senderDid: 'did:key:receiver',
          content: 'Hello',
          timestamp: '2024-01-15T10:00:00Z',
        },
        {
          messageId: 'msg_002',
          connectionId: testConnectionId,
          senderDid: 'did:key:sender',
          content: 'Hi there',
          timestamp: '2024-01-15T10:01:00Z',
        },
      ],
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].messageId).toBe('msg_001');
    expect(body.messages[0].senderDid).toBe('did:key:receiver');
    expect(body.messages[0].content).toBe('Hello');
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

  it('should return 403 for unauthorized connection', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: null,
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(403);
  });

  it('should support pagination with nextToken', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        userId: 'did:key:sender',
        connectionId: testConnectionId,
        targetDid: testTargetDid,
        status: 'CONNECTED',
      },
    });

    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          messageId: 'msg_001',
          connectionId: testConnectionId,
          senderDid: 'did:key:receiver',
          content: 'Hello',
          timestamp: '2024-01-15T10:00:00Z',
        },
      ],
      LastEvaluatedKey: {
        receiverDid: testTargetDid,
        timestamp: '2024-01-15T10:00:00Z',
      },
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.messages).toHaveLength(1);
    expect(body.nextToken).toBeDefined();
  });

  it('should filter messages from other connections', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        userId: 'did:key:sender',
        connectionId: testConnectionId,
        targetDid: testTargetDid,
        status: 'CONNECTED',
      },
    });

    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          messageId: 'msg_001',
          connectionId: testConnectionId,
          senderDid: 'did:key:receiver',
          content: 'Hello',
          timestamp: '2024-01-15T10:00:00Z',
        },
        {
          messageId: 'msg_002',
          connectionId: 'other-connection-id',
          senderDid: 'did:key:other',
          content: 'Wrong connection',
          timestamp: '2024-01-15T10:01:00Z',
        },
      ],
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].messageId).toBe('msg_001');
  });
});
