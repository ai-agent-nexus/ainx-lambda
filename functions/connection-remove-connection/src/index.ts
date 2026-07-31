import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import { ConnectionStatus } from '@ainx/connection-utils';

const logger = new Logger('remove-connection');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME!;

if (!CONNECTIONS_TABLE_NAME) {
  throw new Error('CONNECTIONS_TABLE_NAME environment variable is required');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Remove connection invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    const pathMatch = event.path.match(/^\/connections\/(.+)$/);
    if (!pathMatch || event.httpMethod !== 'DELETE') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const connectionId = pathMatch[1];
    const userId = event.requestContext.authorizer?.did as string;

    if (!userId) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const connectionResult = await dynamodb.send(new GetCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      Key: {
        userId,
        connectionId,
      },
    }));

    if (!connectionResult.Item) {
      logger.warn('Connection not found', { userId, connectionId });
      return formatResponse(404, {
        error: 'Connection not found',
        code: 'CONNECTION_NOT_FOUND',
      });
    }

    if (connectionResult.Item.status !== ConnectionStatus.CONNECTED) {
      logger.warn('Connection not active', {
        userId,
        connectionId,
        status: connectionResult.Item.status,
      });
      return formatResponse(400, {
        error: 'Connection is not active',
        code: 'CONNECTION_NOT_ACTIVE',
      });
    }

    const now = new Date().toISOString();

    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: CONNECTIONS_TABLE_NAME,
            Key: {
              userId,
              connectionId,
            },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': ConnectionStatus.DISCONNECTED,
              ':updatedAt': now,
            },
          },
        },
        {
          Update: {
            TableName: CONNECTIONS_TABLE_NAME,
            Key: {
              userId: connectionId,
              connectionId: userId,
            },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': ConnectionStatus.DISCONNECTED,
              ':updatedAt': now,
            },
          },
        },
      ],
    }));

    logger.info('Connection removed', { userId, connectionId });

    return formatResponse(200, {
      message: 'Connection removed successfully',
      userId,
      connectionId,
      status: ConnectionStatus.DISCONNECTED,
      updatedAt: now,
    });
  } catch (error) {
    logger.error('Error in remove-connection handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
