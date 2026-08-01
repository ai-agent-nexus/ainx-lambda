import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { generateMessageId, generateIdempotencyKey, isValidMessageContent, SendMessageRequest } from '@ainx/connection-utils';

const logger = new Logger('connection-message-send');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME || '';
const MESSAGES_TABLE_NAME = process.env.MESSAGES_TABLE_NAME || '';

if (!CONNECTIONS_TABLE_NAME || !MESSAGES_TABLE_NAME) {
  throw new Error('Required environment variables are missing');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Send message invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    // Extract connectionId from path
    const pathMatch = event.path.match(/^\/connections\/([^/]+)\/messages$/);
    if (!pathMatch || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const connectionId = pathMatch[1];
    const senderDid = event.requestContext.authorizer?.did as string;

    if (!senderDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    // Parse request body
    const body = parseBody<SendMessageRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const { content } = body;

    // Validate content
    if (!isValidMessageContent(content)) {
      logger.warn('Invalid message content', { content });
      return formatResponse(400, {
        error: 'Invalid message content',
        code: 'INVALID_CONTENT',
      });
    }

    // Verify connection exists and sender is part of it
    const connectionResult = await dynamodb.send(
      new GetCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        Key: {
          userId: senderDid,
          connectionId,
        },
      })
    );

    if (!connectionResult.Item) {
      logger.warn('Connection not found or user not part of connection', { senderDid, connectionId });
      return formatResponse(403, {
        error: 'You are not part of this connection',
        code: 'NOT_AUTHORIZED',
      });
    }

    // Get receiver DID (the other party in the connection)
    const receiverDid = connectionId; // connectionId is the other user's DID

    // Check for duplicate (idempotency)
    const idempotencyKey = event.headers['x-idempotency-key'] || generateIdempotencyKey();
    const existingMessage = await dynamodb.send(
      new QueryCommand({
        TableName: MESSAGES_TABLE_NAME,
        KeyConditionExpression: 'receiverDid = :receiverDid',
        FilterExpression: 'messageIdempotencyKey = :idempotencyKey',
        ExpressionAttributeValues: {
          ':receiverDid': receiverDid,
          ':idempotencyKey': idempotencyKey,
        },
        Limit: 1,
      })
    );

    if (existingMessage.Items && existingMessage.Items.length > 0) {
      logger.info('Duplicate message detected, returning existing message', { idempotencyKey });
      return formatResponse(200, {
        success: true,
        messageId: existingMessage.Items[0].messageId,
      });
    }

    // Generate message ID and timestamp
    const messageId = generateMessageId();
    const timestamp = new Date().toISOString();

    // Store message in DynamoDB
    await dynamodb.send(
      new PutCommand({
        TableName: MESSAGES_TABLE_NAME,
        Item: {
          messageId,
          connectionId,
          senderDid,
          receiverDid,
          content,
          timestamp,
          messageIdempotencyKey: idempotencyKey,
        },
      })
    );

    logger.info('Message sent successfully', { messageId, senderDid, receiverDid, connectionId });

    return formatResponse(201, {
      success: true,
      messageId,
    });
  } catch (error) {
    logger.error('Error in connection-message-send handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
