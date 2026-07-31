import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import { ConnectionRequestStatus } from '@ainx/connection-utils';

const logger = new Logger('list-requests');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const CONNECTION_REQUESTS_TABLE_NAME = process.env.CONNECTION_REQUESTS_TABLE_NAME!;

if (!CONNECTION_REQUESTS_TABLE_NAME) {
  throw new Error('CONNECTION_REQUESTS_TABLE_NAME environment variable is required');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('List requests invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/connections/requests' || event.httpMethod !== 'GET') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const toDid = event.requestContext.authorizer?.did as string;
    if (!toDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const limit = parseInt(event.queryStringParameters?.limit || '20', 10);
    const nextToken = event.queryStringParameters?.nextToken;

    const queryParams: {
      TableName: string;
      IndexName: string;
      KeyConditionExpression: string;
      FilterExpression: string;
      ExpressionAttributeNames: { '#status': string };
      ExpressionAttributeValues: { ':toDid': string; ':status': ConnectionRequestStatus };
      Limit: number;
      ExclusiveStartKey?: Record<string, unknown>;
    } = {
      TableName: CONNECTION_REQUESTS_TABLE_NAME,
      IndexName: 'ToDidIndex',
      KeyConditionExpression: 'toDid = :toDid',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':toDid': toDid,
        ':status': ConnectionRequestStatus.PENDING,
      },
      Limit: Math.min(Math.max(limit, 1), 100),
    };

    if (nextToken) {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
    }

    const result = await dynamodb.send(new QueryCommand(queryParams));

    const requests = (result.Items || []).map((item) => ({
      requestId: item.requestId as string,
      fromDid: item.fromDid as string,
      status: item.status as string,
      createdAt: item.createdAt as string,
      expiresAt: item.expiresAt as string,
    }));

    const response: Record<string, unknown> = {
      requests,
    };

    if (result.LastEvaluatedKey) {
      response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    logger.info('Requests listed', { toDid, count: requests.length });

    return formatResponse(200, response);
  } catch (error) {
    logger.error('Error in list-requests handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
