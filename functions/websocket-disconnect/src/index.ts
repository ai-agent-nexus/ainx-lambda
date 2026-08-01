import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';

const logger = new Logger('websocket-disconnect');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const WEBSOCKET_CONNECTIONS_TABLE_NAME = process.env.WEBSOCKET_CONNECTIONS_TABLE_NAME || '';

if (!WEBSOCKET_CONNECTIONS_TABLE_NAME) {
  throw new Error('Required environment variables are missing');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('WebSocket disconnect invoked', {
      connectionId: event.requestContext.connectionId,
    });

    const connectionId = event.requestContext.connectionId;
    if (!connectionId) {
      logger.warn('Missing connectionId');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing connectionId' }),
      };
    }

    // Delete connection mapping
    await dynamodb.send(
      new DeleteCommand({
        TableName: WEBSOCKET_CONNECTIONS_TABLE_NAME,
        Key: { connectionId },
      })
    );

    logger.info('WebSocket connection removed', { connectionId });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Disconnected' }),
    };
  } catch (error) {
    logger.error('Error in websocket-disconnect handler', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
