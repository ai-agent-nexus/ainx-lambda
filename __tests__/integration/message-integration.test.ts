import { setupTestEnv } from './utils/helpers';

setupTestEnv({
  CONNECTIONS_TABLE_NAME: 'test-connections-table',
  MESSAGES_TABLE_NAME: 'test-messages-table',
});

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as sendHandler } from '../../functions/connection-message-send/src/index';
import { handler as listHandler } from '../../functions/connection-message-list/src/index';

// Mock dependencies
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

// Simple in-memory mock for DynamoDB
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (command: unknown) => mockSend(command),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
}));

describe('Integration: Message Flow', () => {
  const senderDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender';
  const receiverDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_receiver';

  beforeEach(() => {
    mockSend.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Happy Path: Send Message', () => {
    it('should send message successfully', async () => {
      // Mock connection exists
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock no duplicate
      mockSend.mockResolvedValueOnce({
        Items: [],
      });

      // Mock put message
      mockSend.mockResolvedValueOnce({});

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello, this is a test message!' }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        headers: {},
      };

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(201);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.success).toBe(true);
      expect(sendBody.messageId).toBeDefined();
    });

    it('should handle idempotency', async () => {
      const idempotencyKey = 'test-idempotency-key-123';

      // Mock connection exists
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock duplicate exists
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            messageId: 'msg_existing123',
            messageIdempotencyKey: idempotencyKey,
          },
        ],
      });

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello, this is a test message!' }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        headers: {
          'x-idempotency-key': idempotencyKey,
        },
      };

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(200);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.success).toBe(true);
      expect(sendBody.messageId).toBe('msg_existing123');
    });
  });

  describe('Happy Path: List Messages', () => {
    it('should list messages for connection', async () => {
      // Mock connection exists
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock messages
      mockSend.mockResolvedValueOnce({
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

      const listEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {},
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const listResult = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(listResult.statusCode).toBe(200);
      const listBody = JSON.parse(listResult.body);
      expect(listBody.messages).toHaveLength(2);
      expect(listBody.messages[0].messageId).toBe('msg_001');
      expect(listBody.messages[1].messageId).toBe('msg_002');
    });

    it('should support pagination', async () => {
      // Mock connection exists
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: senderDid,
          connectionId: receiverDid,
          status: 'CONNECTED',
        },
      });

      // Mock messages with pagination
      mockSend.mockResolvedValueOnce({
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

      const listEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'GET',
        queryStringParameters: {
          limit: '1',
        },
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const listResult = await listHandler(listEvent as APIGatewayProxyEvent);
      expect(listResult.statusCode).toBe(200);
      const listBody = JSON.parse(listResult.body);
      expect(listBody.messages).toHaveLength(1);
      expect(listBody.nextToken).toBeDefined();
    });
  });

  describe('Error Cases', () => {
    it('should reject message to unauthorized connection', async () => {
      const unauthorizedReceiver = 'did:key:unauthorized';

      // Mock connection not found
      mockSend.mockResolvedValueOnce({
        Item: null,
      });

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${unauthorizedReceiver}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello!' }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        headers: {},
      };

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(403);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.error).toBe('You are not part of this connection');
    });

    it('should reject empty message content', async () => {
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: '' }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        headers: {},
      };

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(400);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.error).toBe('Invalid message content');
    });

    it('should reject missing authorization', async () => {
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}/messages`,
        httpMethod: 'POST',
        body: JSON.stringify({ content: 'Hello!' }),
        requestContext: {} as any,
        headers: {},
      };

      const sendResult = await sendHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(401);
    });
  });
});
