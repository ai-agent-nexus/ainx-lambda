import { handler as sendHandler } from '../functions/connection-message-send/src/index';
import { handler as listHandler } from '../functions/connection-message-list/src/index';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Mock DynamoDB
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

describe('Message Integration Tests', () => {
  let mockDynamoDB: any;
  let senderDid: string;
  let receiverDid: string;
  let connectionId: string;

  beforeEach(() => {
    jest.clearAllMocks();
    senderDid = 'did:key:sender123';
    receiverDid = 'did:key:receiver456';
    connectionId = receiverDid;

    process.env.CONNECTIONS_TABLE_NAME = 'test-connections';
    process.env.MESSAGES_TABLE_NAME = 'test-messages';

    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    mockDynamoDB = DynamoDBDocumentClient.from();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /connections/{connectionId}/messages', () => {
    it('should send message and return 201', async () => {
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello, this is a test message!' }),
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
        headers: {},
      };

      // Mock connection exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock no duplicate
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [],
      });

      // Mock put message
      mockDynamoDB.send.mockResolvedValueOnce({});

      const result = await sendHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.messageId).toBeDefined();
    });

    it('should handle duplicate message with idempotency', async () => {
      const idempotencyKey = 'test-idempotency-key-123';
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello, this is a test message!' }),
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
        headers: {
          'x-idempotency-key': idempotencyKey,
        },
      };

      // Mock connection exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock duplicate exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_existing123',
            messageIdempotencyKey: idempotencyKey,
          },
        ],
      });

      const result = await sendHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.messageId).toBe('msg_existing123');
    });

    it('should reject message to unauthorized connection', async () => {
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello!' }),
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
        headers: {},
      };

      // Mock connection not found
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: null,
      });

      const result = await sendHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('You are not part of this connection');
    });
  });

  describe('GET /connections/{connectionId}/messages', () => {
    it('should list messages for connection', async () => {
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {},
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
      };

      // Mock connection exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock messages
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_001',
            connectionId: receiverDid,
            senderDid: receiverDid,
            content: 'Hello from receiver',
            timestamp: '2024-01-15T10:00:00Z',
          },
          {
            messageId: 'msg_002',
            connectionId: receiverDid,
            senderDid: senderDid,
            content: 'Hi from sender',
            timestamp: '2024-01-15T10:01:00Z',
          },
        ],
      });

      const result = await listHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].messageId).toBe('msg_001');
      expect(body.messages[1].messageId).toBe('msg_002');
    });

    it('should support pagination', async () => {
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {
          limit: '1',
        },
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
      };

      // Mock connection exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock messages with pagination
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_001',
            connectionId: receiverDid,
            senderDid: receiverDid,
            content: 'Hello',
            timestamp: '2024-01-15T10:00:00Z',
          },
        ],
        LastEvaluatedKey: {
          receiverDid: senderDid,
          timestamp: '2024-01-15T10:00:00Z',
        },
      });

      const result = await listHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.messages).toHaveLength(1);
      expect(body.nextToken).toBeDefined();
    });

    it('should filter messages from other connections', async () => {
      const mockEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {},
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
      };

      // Mock connection exists
      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock messages including one from different connection
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_001',
            connectionId: receiverDid,
            senderDid: receiverDid,
            content: 'Valid message',
            timestamp: '2024-01-15T10:00:00Z',
          },
          {
            messageId: 'msg_002',
            connectionId: 'did:key:other',
            senderDid: 'did:key:other',
            content: 'Wrong connection',
            timestamp: '2024-01-15T10:01:00Z',
          },
        ],
      });

      const result = await listHandler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].messageId).toBe('msg_001');
    });
  });

  describe('End-to-end message flow', () => {
    it('should send and list messages in sequence', async () => {
      // Step 1: Send message
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Test message flow' }),
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
        headers: {},
      };

      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [],
      });

      mockDynamoDB.send.mockResolvedValueOnce({});

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(201);
      const sendBody = JSON.parse(sendResult.body);
      const messageId = sendBody.messageId;

      // Step 2: List messages
      const listEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {},
        requestContext: {
          authorizer: {
            did: receiverDid,
          },
        } as any,
      };

      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: receiverDid,
          connectionId: senderDid,
          status: 'CONNECTED',
        },
      });

      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId,
            connectionId: receiverDid,
            senderDid,
            content: 'Test message flow',
            timestamp: '2024-01-15T10:00:00Z',
          },
        ],
      });

      const listResult = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(listResult.statusCode).toBe(200);
      const listBody = JSON.parse(listResult.body);
      expect(listBody.messages).toHaveLength(1);
      expect(listBody.messages[0].messageId).toBe(messageId);
      expect(listBody.messages[0].content).toBe('Test message flow');
    });
  });
});
