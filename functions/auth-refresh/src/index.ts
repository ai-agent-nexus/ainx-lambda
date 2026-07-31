import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import jwt from 'jsonwebtoken';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('auth-refresh');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const REFRESH_TOKEN_TABLE_NAME = process.env.REFRESH_TOKEN_TABLE_NAME!;
const AGENT_REGISTRATION_TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n') || '';
const JWT_ISSUER = process.env.JWT_ISSUER || 'ainx-api';
const JWT_EXPIRES_IN_SECONDS = parseInt(process.env.JWT_EXPIRES_IN_SECONDS || '3600', 10);
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '7', 10);

if (!REFRESH_TOKEN_TABLE_NAME) {
  throw new Error('REFRESH_TOKEN_TABLE_NAME environment variable is required');
}
if (!AGENT_REGISTRATION_TABLE_NAME) {
  throw new Error('AGENT_REGISTRATION_TABLE_NAME environment variable is required');
}
if (!JWT_PRIVATE_KEY) {
  throw new Error('JWT_PRIVATE_KEY environment variable is required');
}

interface RefreshRequest {
  refresh_token: string;
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Auth refresh invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/auth/refresh' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const body = parseBody<RefreshRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const validation = validateInput(body as unknown as Record<string, unknown>, ['refresh_token']);
    if (!validation.valid) {
      logger.warn('Missing required fields', { missing: validation.missingFields });
      return formatResponse(400, {
        error: `Missing required fields: ${validation.missingFields.join(', ')}`,
        code: 'MISSING_FIELDS',
      });
    }

    const { refresh_token } = body;

    // Verify refresh token exists and is valid
    let refreshTokenData: Record<string, unknown> | undefined;
    try {
      const tokenResult = await dynamodb.send(new GetCommand({
        TableName: REFRESH_TOKEN_TABLE_NAME,
        Key: { token: refresh_token },
      }));

      if (!tokenResult.Item) {
        logger.warn('Refresh token not found', {
          refresh_token: refresh_token.substring(0, 10) + '...',
        });
        return formatResponse(401, {
          error: 'Invalid refresh token',
          code: 'INVALID_REFRESH_TOKEN',
        });
      }

      refreshTokenData = tokenResult.Item;

      // Check if token is revoked
      if (refreshTokenData.isRevoked) {
        logger.warn('Refresh token is revoked', {
          refresh_token: refresh_token.substring(0, 10) + '...',
        });
        return formatResponse(401, {
          error: 'Invalid refresh token',
          code: 'INVALID_REFRESH_TOKEN',
        });
      }

      // Check if token is expired
      const expiresAt = new Date(refreshTokenData.expiresAt as string);
      if (expiresAt < new Date()) {
        logger.warn('Refresh token expired', {
          refresh_token: refresh_token.substring(0, 10) + '...',
        });
        return formatResponse(401, {
          error: 'Invalid refresh token',
          code: 'INVALID_REFRESH_TOKEN',
        });
      }
    } catch (err) {
      logger.error('Error verifying refresh token', { error: (err as Error).message });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    const userId = refreshTokenData.userId as string;
    const did = refreshTokenData.did as string;

    // Verify DID is still active
    try {
      const didResult = await dynamodb.send(new QueryCommand({
        TableName: AGENT_REGISTRATION_TABLE_NAME,
        IndexName: 'DidIndex',
        KeyConditionExpression: 'did = :did',
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':did': did,
          ':status': 'active',
        },
      }));

      if (!didResult.Items || didResult.Items.length === 0) {
        logger.warn('DID not active', { did });
        return formatResponse(401, {
          error: 'DID not found or revoked',
          code: 'DID_NOT_FOUND',
        });
      }
    } catch (err) {
      logger.error('Error querying DID', { error: (err as Error).message, did });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    // Generate new JWT access token
    const now = Math.floor(Date.now() / 1000);
    const jti = uuidv4();
    const accessTokenPayload = {
      sub: userId,
      did,
      iat: now,
      exp: now + JWT_EXPIRES_IN_SECONDS,
      iss: JWT_ISSUER,
      jti,
      scope: 'agent:read agent:write',
    };

    let accessToken: string;
    try {
      accessToken = jwt.sign(accessTokenPayload, JWT_PRIVATE_KEY, {
        algorithm: 'RS256',
        keyid: 'key-2024-01',
      });
    } catch (err) {
      logger.error('Error signing JWT', { error: (err as Error).message });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    // Generate new refresh token
    const newRefreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date();
    refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);
    const refreshTokenTtl = Math.floor(refreshTokenExpiresAt.getTime() / 1000);

    // Store new refresh token and delete old one (transaction)
    try {
      await dynamodb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: REFRESH_TOKEN_TABLE_NAME,
              Item: {
                token: newRefreshToken,
                userId,
                did,
                createdAt: new Date().toISOString(),
                expiresAt: refreshTokenExpiresAt.toISOString(),
                ttl: refreshTokenTtl,
                isRevoked: false,
              },
            },
          },
          {
            Delete: {
              TableName: REFRESH_TOKEN_TABLE_NAME,
              Key: { token: refresh_token },
            },
          },
        ],
      }));
    } catch (err) {
      logger.error('Error updating refresh token', { error: (err as Error).message });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    logger.info('Token refreshed successfully', { did, userId, jti });

    const response: RefreshResponse = {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: JWT_EXPIRES_IN_SECONDS,
      token_type: 'Bearer',
    };

    return formatResponse(200, response as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error('Error in auth-refresh handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};

function generateRefreshToken(): string {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString('base64url');
}
