import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import jwt from 'jsonwebtoken';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';

const logger = new Logger('agent-revoke');
const dynamodb = new DynamoDB.DocumentClient();

const AGENT_REGISTRATION_TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;
const DID_UNIQUENESS_TABLE_NAME = process.env.DID_UNIQUENESS_TABLE_NAME!;
const REFRESH_TOKEN_TABLE_NAME = process.env.REFRESH_TOKEN_TABLE_NAME!;
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n') || '';
const JWT_ISSUER = process.env.JWT_ISSUER || 'ainx-api';

if (!AGENT_REGISTRATION_TABLE_NAME) {
  throw new Error('AGENT_REGISTRATION_TABLE_NAME environment variable is required');
}
if (!DID_UNIQUENESS_TABLE_NAME) {
  throw new Error('DID_UNIQUENESS_TABLE_NAME environment variable is required');
}
if (!REFRESH_TOKEN_TABLE_NAME) {
  throw new Error('REFRESH_TOKEN_TABLE_NAME environment variable is required');
}
if (!JWT_PUBLIC_KEY) {
  throw new Error('JWT_PUBLIC_KEY environment variable is required');
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
    logger.info('Agent revoke invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.httpMethod !== 'DELETE') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    // Extract DID from path
    const pathMatch = event.path.match(/^\/agents\/(.+)$/);
    if (!pathMatch) {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const targetDid = pathMatch[1];

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
      logger.error('JWT verification error', {
        error: (err as Error).message,
        name: (err as Error).name,
      });
      return formatResponse(401, {
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
    }

    const { did: authDid, sub: userId } = decodedToken;

    // Verify the user can only revoke their own DID
    if (authDid !== targetDid) {
      logger.warn('Unauthorized revocation attempt', { authDid, targetDid });
      return formatResponse(403, {
        error: 'You can only revoke your own agent',
        code: 'INSUFFICIENT_SCOPE',
      });
    }

    // Verify DID exists and is active
    try {
      const didResult = await dynamodb
        .get({
          TableName: AGENT_REGISTRATION_TABLE_NAME,
          Key: { userId, did: targetDid },
        })
        .promise();

      if (!didResult.Item) {
        logger.warn('DID not found', { did: targetDid });
        return formatResponse(404, {
          error: 'Agent not found',
          code: 'DID_NOT_FOUND',
        });
      }

      if (didResult.Item.status !== 'active') {
        logger.warn('DID already revoked', { did: targetDid });
        return formatResponse(400, {
          error: 'Agent already revoked',
          code: 'DID_REVOKED',
        });
      }
    } catch (err) {
      logger.error('Error querying DID', { error: (err as Error).message, did: targetDid });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    const now = new Date();

    // Update agent status to revoked
    try {
      await dynamodb
        .update({
          TableName: AGENT_REGISTRATION_TABLE_NAME,
          Key: { userId, did: targetDid },
          UpdateExpression: 'SET #status = :status, revokedAt = :revokedAt, updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': 'revoked',
            ':revokedAt': now.toISOString(),
            ':updatedAt': now.toISOString(),
          },
        })
        .promise();
    } catch (err) {
      logger.error('Error updating agent status', {
        error: (err as Error).message,
        did: targetDid,
      });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    // Delete all refresh tokens for this user
    try {
      // Query all refresh tokens for this user
      const tokenResult = await dynamodb
        .query({
          TableName: REFRESH_TOKEN_TABLE_NAME,
          IndexName: 'UserIdIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
          },
        })
        .promise();

      if (tokenResult.Items) {
        for (const item of tokenResult.Items) {
          await dynamodb
            .delete({
              TableName: REFRESH_TOKEN_TABLE_NAME,
              Key: { token: item.token },
            })
            .promise();
        }
      }
    } catch (err) {
      logger.error('Error deleting refresh tokens', { error: (err as Error).message, userId });
      // Don't fail if refresh token deletion fails
    }

    logger.info('Agent revoked successfully', {
      did: targetDid,
      userId,
      revokedAt: now.toISOString(),
    });

    return formatResponse(200, {
      message: 'Agent revoked successfully',
      did: targetDid,
      revokedAt: now.toISOString(),
    });
  } catch (error) {
    logger.error('Error in agent-revoke handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
