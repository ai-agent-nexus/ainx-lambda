import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import jwt from 'jsonwebtoken';
import { Logger } from '@ainx/logger';

const logger = new Logger('jwt-authorizer');
const dynamodb = new DynamoDB.DocumentClient();

const TOKEN_BLACKLIST_TABLE_NAME = process.env.TOKEN_BLACKLIST_TABLE_NAME!;
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY!;
const JWT_ISSUER = process.env.JWT_ISSUER || 'ainx-api';

if (!TOKEN_BLACKLIST_TABLE_NAME) {
  throw new Error('TOKEN_BLACKLIST_TABLE_NAME environment variable is required');
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

interface AuthContext {
  did: string;
  userId: string;
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  try {
    logger.info('JWT authorizer invoked', {
      methodArn: event.methodArn,
      token: event.authorizationToken ? 'present' : 'missing',
    });

    const token = event.authorizationToken;

    if (!token) {
      logger.warn('Missing authorization token');
      return generateDenyAllPolicy();
    }

    // Verify JWT
    let decodedToken: JwtPayload;
    try {
      decodedToken = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: JWT_ISSUER,
      }) as JwtPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        logger.warn('Token expired');
        return generateDenyAllPolicy();
      }
      if (err instanceof jwt.JsonWebTokenError) {
        logger.warn('Invalid token', { error: err.message });
        return generateDenyAllPolicy();
      }
      throw err;
    }

    const { jti, did, sub: userId } = decodedToken;

    // Check if token is blacklisted
    try {
      const blacklistResult = await dynamodb
        .get({
          TableName: TOKEN_BLACKLIST_TABLE_NAME,
          Key: { jti },
        })
        .promise();

      if (blacklistResult.Item) {
        logger.warn('Token is blacklisted', { jti });
        return generateDenyAllPolicy();
      }
    } catch (err) {
      logger.error('Error checking blacklist', { error: (err as Error).message, jti });
      return generateDenyAllPolicy();
    }

    logger.info('JWT authorization successful', { did, userId, jti });

    return generateAllowPolicy(event.methodArn, { did, userId });
  } catch (error) {
    logger.error('Error in jwt-authorizer handler', { error });
    return generateDenyAllPolicy();
  }
};

function generateAllowPolicy(methodArn: string, context: AuthContext): APIGatewayAuthorizerResult {
  return {
    principalId: context.did,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: 'Allow',
          Resource: methodArn,
        },
      ],
    },
    context: {
      did: context.did,
      userId: context.userId,
    },
  };
}

function generateDenyAllPolicy(): APIGatewayAuthorizerResult {
  return {
    principalId: 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: 'Deny',
          Resource: '*',
        },
      ],
    },
  };
}
