import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { parseDidKey } from '@ainx/did-utils';

const logger = new Logger('auth-challenge');
const dynamodb = new DynamoDB.DocumentClient();
const CHALLENGE_TABLE_NAME = process.env.CHALLENGE_TABLE_NAME!;

if (!CHALLENGE_TABLE_NAME) {
  throw new Error('CHALLENGE_TABLE_NAME environment variable is required');
}

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

interface ChallengeRequest {
  did: string;
}

interface ChallengeResponse {
  challenge: string;
  expires_at: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Auth challenge invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/auth/challenge' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const body = parseBody<ChallengeRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const validation = validateInput(body as unknown as Record<string, unknown>, ['did']);
    if (!validation.valid) {
      logger.warn('Missing required fields', { missing: validation.missingFields });
      return formatResponse(400, {
        error: `Missing required fields: ${validation.missingFields.join(', ')}`,
        code: 'MISSING_FIELDS',
      });
    }

    const { did } = body;

    // Validate DID format
    try {
      parseDidKey(did);
    } catch (err) {
      logger.warn('Invalid DID format', { did, error: (err as Error).message });
      return formatResponse(400, {
        error: 'Invalid DID format',
        code: 'INVALID_DID',
      });
    }

    // Generate random challenge
    const challenge = generateChallenge();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);
    const ttl = Math.floor(expiresAt.getTime() / 1000);

    // Store challenge in DynamoDB with TTL
    try {
      await dynamodb
        .put({
          TableName: CHALLENGE_TABLE_NAME,
          Item: {
            did,
            challenge,
            createdAt: now.toISOString(),
            ttl,
          },
        })
        .promise();
    } catch (err) {
      logger.error('Error storing challenge', { error: (err as Error).message, did });
      return formatResponse(500, {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }

    logger.info('Challenge generated successfully', {
      did,
      challenge,
      expiresAt: expiresAt.toISOString(),
    });

    const response: ChallengeResponse = {
      challenge,
      expires_at: expiresAt.toISOString(),
    };

    return formatResponse(200, response as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error('Error in auth-challenge handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};

function generateChallenge(): string {
  // Generate a random challenge string (32 bytes, base64url encoded)
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString('base64url');
}
