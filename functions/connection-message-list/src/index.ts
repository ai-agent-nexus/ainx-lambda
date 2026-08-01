import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';
import { MessageListResponse } from '@ainx/connection-utils';

const logger = new Logger('connection-message-list');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const getConnectionsTableName = () => {
  const name = process.env.CONNECTIONS_TABLE_NAME;
  if (!name) {
    throw new Error('Required environment variable CONNECTIONS_TABLE_NAME is missing');
  }
  return name;
};

const getMessagesTableName = () => {
  const name = process.env.MESSAGES_TABLE_NAME;
  if (!name) {
    throw new Error('Required environment variable MESSAGES_TABLE_NAME is missing');
  }
  return name;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('List messages invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    // Extract connectionId from path
    const pathMatch = event.path.match(/^\/connections\/([^/]+)\/messages$/);
    if (!pathMatch || event.httpMethod !== 'GET') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const connectionId = pathMatch[1];
    const userDid = event.requestContext.authorizer?.did as string;

    if (!userDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const connectionsTableName = getConnectionsTableName();
    const messagesTableName = getMessagesTableName();

    // Verify connection exists and user is part of it
    const connectionResult = await dynamodb.send(
      new GetCommand({
        TableName: connectionsTableName,
        Key: {
          userId: userDid,
          connectionId,
        },
      })
    );

    if (!connectionResult.Item) {
      logger.warn('Connection not found or user not part of connection', { userDid, connectionId });
      return formatResponse(403, {
        error: 'You are not part of this connection',
        code: 'NOT_AUTHORIZED',
      });
    }

    // Parse pagination parameters
    const limit = Math.min(
      Math.max(parseInt(event.queryStringParameters?.limit || '20', 10), 1),
      100
    );
    const nextToken = event.queryStringParameters?.nextToken;

    // Query messages where user is receiver
    const queryParams: any = {
      TableName: messagesTableName,
      KeyConditionExpression: 'receiverDid = :receiverDid',
      ExpressionAttributeValues: {
        ':receiverDid': userDid,
      },
      Limit: limit,
      ScanIndexForward: false, // Descending order (newest first)
    };

    if (nextToken) {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
    }

    const result = await dynamodb.send(new QueryCommand(queryParams));

    // Filter messages for this connection only
    const messages = (result.Items || [])
      .filter((item: any) => item.connectionId === connectionId)
      .map((item: any) => ({
        messageId: item.messageId,
        senderDid: item.senderDid,
        content: item.content,
        timestamp: item.timestamp,
      }));

    const response: MessageListResponse = {
      messages,
    };

    // Generate nextToken if there are more results
    if (result.LastEvaluatedKey) {
      response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    logger.info('Messages listed', { userDid, connectionId, count: messages.length });

    return formatResponse(200, response as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error('Error in connection-message-list handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
