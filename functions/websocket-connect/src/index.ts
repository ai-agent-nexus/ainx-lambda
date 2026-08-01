import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import jwt from 'jsonwebtoken';

const logger = new Logger('websocket-connect');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const WEBSOCKET_CONNECTIONS_TABLE_NAME = process.env.WEBSOCKET_CONNECTIONS_TABLE_NAME || '';
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || '';

if (!WEBSOCKET_CONNECTIONS_TABLE_NAME || !JWT_PUBLIC_KEY) {
  throw new Error('Required environment variables are missing');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('WebSocket connect invoked', {
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

    // Extract token from query string
    const token = event.queryStringParameters?.token;
    if (!token) {
      logger.warn('Missing token');
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Missing token' }),
      };
    }

    // Verify JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
    } catch (err) {
      logger.warn('Invalid token', { error: (err as Error).message });
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid token' }),
      };
    }

    const did = decoded.did;
    if (!did) {
      logger.warn('Missing did in token');
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid token payload' }),
      };
    }

    // Store connection mapping
    await dynamodb.send(
      new PutCommand({
        TableName: WEBSOCKET_CONNECTIONS_TABLE_NAME,
        Item: {
          connectionId,
          did,
          connectedAt: new Date().toISOString(),
        },
      })
    );

    logger.info('WebSocket connection established', { connectionId, did });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Connected' }),
    };
  } catch (error) {
    logger.error('Error in websocket-connect handler', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
