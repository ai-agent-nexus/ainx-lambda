import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import {
  CONNECTION_LIMIT,
  ConnectionStatus,
  ConnectionRequestStatus,
} from '@ainx/connection-utils';

const logger = new Logger('accept-request');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const CONNECTION_REQUESTS_TABLE_NAME = process.env.CONNECTION_REQUESTS_TABLE_NAME!;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME!;

if (!CONNECTION_REQUESTS_TABLE_NAME || !CONNECTIONS_TABLE_NAME) {
  throw new Error('Required environment variables are missing');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Accept request invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    const pathMatch = event.path.match(/^\/connections\/requests\/([^/]+)\/accept$/);
    if (!pathMatch || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const requestId = pathMatch[1];
    const toDid = event.requestContext.authorizer?.did as string;

    if (!toDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const requestResult = await dynamodb.send(new GetCommand({
      TableName: CONNECTION_REQUESTS_TABLE_NAME,
      Key: { requestId },
    }));

    if (!requestResult.Item) {
      logger.warn('Request not found', { requestId });
      return formatResponse(404, {
        error: 'Connection request not found',
        code: 'REQUEST_NOT_FOUND',
      });
    }

    const request = requestResult.Item;

    if (request.toDid !== toDid) {
      logger.warn('Unauthorized accept attempt', { requestId, toDid, actualToDid: request.toDid });
      return formatResponse(403, {
        error: 'You can only accept requests sent to you',
        code: 'FORBIDDEN',
      });
    }

    if (request.status !== ConnectionRequestStatus.PENDING) {
      logger.warn('Request not pending', { requestId, status: request.status });
      return formatResponse(409, {
        error: `Request is already ${request.status.toLowerCase()}`,
        code: 'CONFLICT',
      });
    }

    const connectionCount = await dynamodb.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':userId': toDid,
        ':status': ConnectionStatus.CONNECTED,
      },
      Select: 'COUNT',
    }));

    if ((connectionCount.Count || 0) >= CONNECTION_LIMIT) {
      logger.warn('Connection limit reached', { toDid, count: connectionCount.Count });
      return formatResponse(429, {
        error: `Connection limit reached (${CONNECTION_LIMIT})`,
        code: 'TOO_MANY_CONNECTIONS',
      });
    }

    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days

    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: CONNECTION_REQUESTS_TABLE_NAME,
            Key: { requestId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': ConnectionRequestStatus.ACCEPTED,
              ':updatedAt': now,
            },
          },
        },
        {
          Put: {
            TableName: CONNECTIONS_TABLE_NAME,
            Item: {
              userId: request.fromDid,
              connectionId: request.toDid,
              status: ConnectionStatus.CONNECTED,
              createdAt: now,
              updatedAt: now,
              ttl,
            },
          },
        },
        {
          Put: {
            TableName: CONNECTIONS_TABLE_NAME,
            Item: {
              userId: request.toDid,
              connectionId: request.fromDid,
              status: ConnectionStatus.CONNECTED,
              createdAt: now,
              updatedAt: now,
              ttl,
            },
          },
        },
      ],
    }));

    logger.info('Connection request accepted', { requestId, fromDid: request.fromDid, toDid });

    return formatResponse(200, {
      message: 'Connection request accepted',
      requestId,
      fromDid: request.fromDid,
      toDid,
      status: ConnectionRequestStatus.ACCEPTED,
      createdAt: now,
    });
  } catch (error) {
    logger.error('Error in accept-request handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
