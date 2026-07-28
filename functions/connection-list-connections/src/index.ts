import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import { ConnectionStatus, ConnectionListResponse } from '@ainx/connection-utils';

const logger = new Logger('list-connections');
const dynamodb = new DynamoDB.DocumentClient();
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME!;

if (!CONNECTIONS_TABLE_NAME) {
  throw new Error('CONNECTIONS_TABLE_NAME environment variable is required');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('List connections invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/connections' || event.httpMethod !== 'GET') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const userId = event.requestContext.authorizer?.did as string;
    if (!userId) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const limit = parseInt(event.queryStringParameters?.limit || '20', 10);
    const nextToken = event.queryStringParameters?.nextToken;

    const queryParams: DynamoDB.DocumentClient.QueryInput = {
      TableName: CONNECTIONS_TABLE_NAME,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':status': ConnectionStatus.CONNECTED,
      },
      Limit: Math.min(Math.max(limit, 1), 100),
    };

    if (nextToken) {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
    }

    const result = await dynamodb.query(queryParams).promise();

    const connections = (result.Items || []).map((item) => ({
      connectionId: item.connectionId as string,
      status: item.status as ConnectionStatus,
      createdAt: item.createdAt as string,
    }));

    const response: ConnectionListResponse = {
      connections,
    };

    if (result.LastEvaluatedKey) {
      response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    logger.info('Connections listed', { userId, count: connections.length });

    return formatResponse(200, response as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error('Error in list-connections handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
