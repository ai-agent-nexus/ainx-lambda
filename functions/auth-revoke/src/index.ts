import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import jwt from 'jsonwebtoken';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody } from '@ainx/shared-utils';

const logger = new Logger('auth-revoke');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const REFRESH_TOKEN_TABLE_NAME = process.env.REFRESH_TOKEN_TABLE_NAME!;
const TOKEN_BLACKLIST_TABLE_NAME = process.env.TOKEN_BLACKLIST_TABLE_NAME!;
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n') || '';
const JWT_ISSUER = process.env.JWT_ISSUER || 'ainx-api';
const BLACKLIST_TTL_SECONDS = parseInt(process.env.BLACKLIST_TTL_SECONDS || '3600', 10);

if (!REFRESH_TOKEN_TABLE_NAME) {
  throw new Error('REFRESH_TOKEN_TABLE_NAME environment variable is required');
}
if (!TOKEN_BLACKLIST_TABLE_NAME) {
  throw new Error('TOKEN_BLACKLIST_TABLE_NAME environment variable is required');
}
if (!JWT_PUBLIC_KEY) {
  throw new Error('JWT_PUBLIC_KEY environment variable is required');
}

interface RevokeRequest {
  refresh_token?: string;
}

interface JwtPayload {
  sub: string;
  did: string;
  iat: number;
  exp: number;
  iss: string;
  jti: string;
  scope: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Auth revoke invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/auth/revoke' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    // Parse access token from Authorization header
    const authHeader = event.headers.Authorization || event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Missing or invalid Authorization header');
      return formatResponse(401, {
        error: 'Missing or invalid Authorization header',
        code: 'INVALID_TOKEN',
      });
    }

    const accessToken = authHeader.slice(7); // Remove 'Bearer ' prefix

    // Verify and decode access token
    let decodedToken: JwtPayload;
    try {
      decodedToken = jwt.verify(accessToken, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: JWT_ISSUER,
      }) as JwtPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        logger.warn('Token expired');
        return formatResponse(401, {
          error: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
      }
      if (err instanceof jwt.JsonWebTokenError) {
        logger.warn('Invalid token', { error: err.message });
        return formatResponse(401, {
          error: 'Invalid token',
          code: 'INVALID_TOKEN',
        });
      }
      throw err;
    }

    const { jti, did, sub: userId } = decodedToken;

    // Add JTI to blacklist with TTL
    try {
      const now = new Date();
      const ttl = Math.floor(now.getTime() / 1000) + BLACKLIST_TTL_SECONDS;

      await dynamodb.send(
        new PutCommand({
          TableName: TOKEN_BLACKLIST_TABLE_NAME,
          Item: {
            jti,
            did,
            userId,
            revokedAt: now.toISOString(),
            ttl,
          },
        })
      );
    } catch (err) {
      logger.error('Error adding token to blacklist', { error: (err as Error).message, jti });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    // Delete refresh token if provided
    const body = parseBody<RevokeRequest>(event.body);
    if (body && body.refresh_token) {
      try {
        const tokenResult = await dynamodb.send(
          new GetCommand({
            TableName: REFRESH_TOKEN_TABLE_NAME,
            Key: { token: body.refresh_token },
          })
        );

        if ((tokenResult as any).Item && (tokenResult as any).Item.userId === userId) {
          await dynamodb.send(
            new DeleteCommand({
              TableName: REFRESH_TOKEN_TABLE_NAME,
              Key: { token: body.refresh_token },
            })
          );

          logger.info('Refresh token deleted', {
            refresh_token: body.refresh_token.substring(0, 10) + '...',
          });
        } else {
          logger.warn('Refresh token does not belong to user', { userId });
        }
      } catch (err) {
        logger.error('Error deleting refresh token', {
          error: (err as Error).message,
          refresh_token: body.refresh_token.substring(0, 10) + '...',
        });
        // Don't fail if refresh token deletion fails
      }
    }

    logger.info('Token revoked successfully', { did, userId, jti });

    return formatResponse(200, {
      message: 'Token revoked successfully',
    });
  } catch (error) {
    logger.error('Error in auth-revoke handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
