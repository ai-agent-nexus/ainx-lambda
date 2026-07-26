import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import jwt from 'jsonwebtoken';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { parseDidKey } from '@ainx/did-utils';
import { verifySignature } from '@ainx/crypto-utils';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('auth-token');
const dynamodb = new DynamoDB.DocumentClient();

const AGENT_REGISTRATION_TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;
const CHALLENGE_TABLE_NAME = process.env.CHALLENGE_TABLE_NAME!;
const REFRESH_TOKEN_TABLE_NAME = process.env.REFRESH_TOKEN_TABLE_NAME!;
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY!;
const JWT_ISSUER = process.env.JWT_ISSUER || 'ainx-api';
const JWT_EXPIRES_IN_SECONDS = parseInt(process.env.JWT_EXPIRES_IN_SECONDS || '3600', 10);
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '7', 10);

if (!AGENT_REGISTRATION_TABLE_NAME) {
  throw new Error('AGENT_REGISTRATION_TABLE_NAME environment variable is required');
}
if (!CHALLENGE_TABLE_NAME) {
  throw new Error('CHALLENGE_TABLE_NAME environment variable is required');
}
if (!REFRESH_TOKEN_TABLE_NAME) {
  throw new Error('REFRESH_TOKEN_TABLE_NAME environment variable is required');
}
if (!JWT_PRIVATE_KEY) {
  throw new Error('JWT_PRIVATE_KEY environment variable is required');
}

interface TokenRequest {
  did: string;
  challenge: string;
  signature: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Auth token invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/auth/token' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const body = parseBody<TokenRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const validation = validateInput(body as unknown as Record<string, unknown>, [
      'did',
      'challenge',
      'signature',
    ]);
    if (!validation.valid) {
      logger.warn('Missing required fields', { missing: validation.missingFields });
      return formatResponse(400, {
        error: `Missing required fields: ${validation.missingFields.join(', ')}`,
        code: 'MISSING_FIELDS',
      });
    }

    const { did, challenge, signature } = body;

    // Validate DID format
    let publicKey: Buffer;
    try {
      const parsed = parseDidKey(did);
      publicKey = parsed.publicKey;
    } catch (err) {
      logger.warn('Invalid DID format', { did, error: (err as Error).message });
      return formatResponse(400, {
        error: 'Invalid DID format',
        code: 'INVALID_DID',
      });
    }

    // Verify DID signature
    const signatureBuffer = Buffer.from(signature, 'base64');
    let signatureValid: boolean;
    try {
      signatureValid = verifySignature(publicKey, challenge, signatureBuffer);
    } catch (err) {
      logger.warn('Signature verification error', { error: (err as Error).message });
      return formatResponse(401, {
        error: 'Invalid signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    if (!signatureValid) {
      logger.warn('Signature verification failed', { did });
      return formatResponse(401, {
        error: 'Invalid signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    // Verify challenge exists and is valid
    let challengeValid = false;
    try {
      const challengeResult = await dynamodb
        .get({
          TableName: CHALLENGE_TABLE_NAME,
          Key: { did },
        })
        .promise();

      if (challengeResult.Item && challengeResult.Item.challenge === challenge) {
        challengeValid = true;
        // Delete challenge after use (one-time use)
        await dynamodb
          .delete({
            TableName: CHALLENGE_TABLE_NAME,
            Key: { did },
          })
          .promise();
      }
    } catch (err) {
      logger.error('Error verifying challenge', { error: (err as Error).message, did });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    if (!challengeValid) {
      logger.warn('Invalid or expired challenge', { did, challenge });
      return formatResponse(400, {
        error: 'Invalid or expired challenge',
        code: 'INVALID_CHALLENGE',
      });
    }

    // Verify DID exists and is active
    let userId: string;
    try {
      const didResult = await dynamodb
        .get({
          TableName: AGENT_REGISTRATION_TABLE_NAME,
          Key: { did },
        })
        .promise();

      if (!didResult.Item) {
        logger.warn('DID not found', { did });
        return formatResponse(401, {
          error: 'DID not found or revoked',
          code: 'DID_NOT_FOUND',
        });
      }

      const status = didResult.Item.status;
      if (status !== 'active') {
        logger.warn('DID not active', { did, status });
        return formatResponse(401, {
          error: 'DID not found or revoked',
          code: 'DID_NOT_FOUND',
        });
      }

      userId = didResult.Item.userId as string;
    } catch (err) {
      logger.error('Error querying DID', { error: (err as Error).message, did });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    // Generate JWT access token
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

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date();
    refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);
    const refreshTokenTtl = Math.floor(refreshTokenExpiresAt.getTime() / 1000);

    // Store refresh token
    try {
      await dynamodb
        .put({
          TableName: REFRESH_TOKEN_TABLE_NAME,
          Item: {
            token: refreshToken,
            userId,
            did,
            createdAt: new Date().toISOString(),
            expiresAt: refreshTokenExpiresAt.toISOString(),
            ttl: refreshTokenTtl,
            isRevoked: false,
          },
        })
        .promise();
    } catch (err) {
      logger.error('Error storing refresh token', { error: (err as Error).message });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    logger.info('Token generated successfully', { did, userId, jti });

    const response: TokenResponse = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: JWT_EXPIRES_IN_SECONDS,
      token_type: 'Bearer',
    };

    return formatResponse(200, response as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error('Error in auth-token handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};

function generateRefreshToken(): string {
  // Generate a random refresh token (32 bytes, base64url encoded)
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString('base64url');
}
