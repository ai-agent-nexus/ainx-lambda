import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import { ConnectionRequestStatus } from '@ainx/connection-utils';

const logger = new Logger('reject-request');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const CONNECTION_REQUESTS_TABLE_NAME = process.env.CONNECTION_REQUESTS_TABLE_NAME!;

if (!CONNECTION_REQUESTS_TABLE_NAME) {
  throw new Error('CONNECTION_REQUESTS_TABLE_NAME environment variable is required');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Reject request invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    const pathMatch = event.path.match(/^\/connections\/requests\/([^/]+)\/reject$/);
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
      logger.warn('Unauthorized reject attempt', { requestId, toDid, actualToDid: request.toDid });
      return formatResponse(403, {
        error: 'You can only reject requests sent to you',
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

    const now = new Date().toISOString();

    await dynamodb.send(new UpdateCommand({
      TableName: CONNECTION_REQUESTS_TABLE_NAME,
      Key: { requestId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': ConnectionRequestStatus.REJECTED,
        ':updatedAt': now,
      },
    }));

    logger.info('Connection request rejected', { requestId, fromDid: request.fromDid, toDid });

    return formatResponse(200, {
      message: 'Connection request rejected',
      requestId,
      fromDid: request.fromDid,
      toDid,
      status: ConnectionRequestStatus.REJECTED,
      updatedAt: now,
    });
  } catch (error) {
    logger.error('Error in reject-request handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
