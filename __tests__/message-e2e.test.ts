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

describe('Message E2E Tests', () => {
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

  describe('Complete message flow', () => {
    it('should send message and retrieve it in list', async () => {
      // Step 1: Send message from sender to receiver
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello, this is an e2e test!' }),
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
      expect(sendBody.success).toBe(true);
      expect(sendBody.messageId).toBeDefined();
      const messageId = sendBody.messageId;

      // Step 2: Receiver lists messages
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
            content: 'Hello, this is an e2e test!',
            timestamp: '2024-01-15T10:00:00Z',
          },
        ],
      });

      const listResult = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(listResult.statusCode).toBe(200);
      const listBody = JSON.parse(listResult.body);
      expect(listBody.messages).toHaveLength(1);
      expect(listBody.messages[0].messageId).toBe(messageId);
      expect(listBody.messages[0].content).toBe('Hello, this is an e2e test!');
      expect(listBody.messages[0].senderDid).toBe(senderDid);
    });

    it('should handle multiple messages in sequence', async () => {
      const messages = [
        'First message',
        'Second message',
        'Third message',
      ];

      const messageIds: string[] = [];

      for (const content of messages) {
        const sendEvent: Partial<APIGatewayProxyEvent> = {
          path: `/connections/${connectionId}/messages`,
          httpMethod: 'POST',
          body: JSON.stringify({ content }),
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

        const result = await sendHandler(sendEvent as APIGatewayProxyEvent);
        expect(result.statusCode).toBe(201);
        const body = JSON.parse(result.body);
        messageIds.push(body.messageId);
      }

      expect(messageIds).toHaveLength(3);
      expect(new Set(messageIds).size).toBe(3); // All unique
    });

    it('should handle pagination for large message lists', async () => {
      const listEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {
          limit: '2',
        },
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
      };

      mockDynamoDB.send.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_003',
            connectionId: receiverDid,
            senderDid: receiverDid,
            content: 'Message 3',
            timestamp: '2024-01-15T10:02:00Z',
          },
          {
            messageId: 'msg_002',
            connectionId: receiverDid,
            senderDid: senderDid,
            content: 'Message 2',
            timestamp: '2024-01-15T10:01:00Z',
          },
        ],
        LastEvaluatedKey: {
          receiverDid: senderDid,
          timestamp: '2024-01-15T10:01:00Z',
        },
      });

      const result = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.messages).toHaveLength(2);
      expect(body.nextToken).toBeDefined();
    });

    it('should reject messages to non-existent connections', async () => {
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/did:key:nonexistent/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello!' }),
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
        headers: {},
      };

      mockDynamoDB.send.mockResolvedValueOnce({
        Item: null,
      });

      const result = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('You are not part of this connection');
    });

    it('should handle empty message list', async () => {
      const listEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${connectionId}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {},
        requestContext: {
          authorizer: {
            did: senderDid,
          },
        } as any,
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

      const result = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.messages).toHaveLength(0);
      expect(body.nextToken).toBeUndefined();
    });
  });
});
