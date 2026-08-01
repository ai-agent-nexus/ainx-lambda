import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { Logger } from '@ainx/logger';

const logger = new Logger('websocket-push');
const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const WEBSOCKET_CONNECTIONS_TABLE_NAME = process.env.WEBSOCKET_CONNECTIONS_TABLE_NAME || '';
const WEBSOCKET_API_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT || '';

if (!WEBSOCKET_CONNECTIONS_TABLE_NAME || !WEBSOCKET_API_ENDPOINT) {
  throw new Error('Required environment variables are missing');
}

const apiGatewayClient = new ApiGatewayManagementApiClient({
  endpoint: WEBSOCKET_API_ENDPOINT,
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('WebSocket push invoked', { event });

    const { receiverDid, content, messageId, senderDid } = JSON.parse(event.body || '{}');

    if (!receiverDid || !content || !messageId) {
      logger.warn('Missing required fields');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields' }),
      };
    }

    // Find receiver's WebSocket connections
    const connectionsResult = await dynamodb.send(
      new QueryCommand({
        TableName: WEBSOCKET_CONNECTIONS_TABLE_NAME,
        IndexName: 'DidIndex',
        KeyConditionExpression: 'did = :did',
        ExpressionAttributeValues: {
          ':did': receiverDid,
        },
      })
    );

    const connections = connectionsResult.Items || [];

    if (connections.length === 0) {
      logger.info('Receiver not online', { receiverDid });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Receiver not online' }),
      };
    }

    // Push message to all receiver's connections
    const pushPromises = connections.map(async (connection: any) => {
      try {
        await apiGatewayClient.send(
          new PostToConnectionCommand({
            ConnectionId: connection.connectionId,
            Data: JSON.stringify({
              messageId,
              senderDid,
              content,
              timestamp: new Date().toISOString(),
            }),
          })
        );
      } catch (error: any) {
        if (error.name === 'GoneException') {
          // Connection is stale, remove it
          logger.warn('Connection is gone, removing', { connectionId: connection.connectionId });
          await dynamodb.send(
            new DeleteCommand({
              TableName: WEBSOCKET_CONNECTIONS_TABLE_NAME,
              Key: { connectionId: connection.connectionId },
            })
          );
        } else {
          logger.error('Error pushing message', { error, connectionId: connection.connectionId });
        }
      }
    });

    await Promise.all(pushPromises);

    logger.info('Message pushed to receiver', { receiverDid, messageId });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Message pushed' }),
    };
  } catch (error) {
    logger.error('Error in websocket-push handler', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
