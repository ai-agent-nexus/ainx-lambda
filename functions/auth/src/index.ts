import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { Logger } from '@ainx/logger';
import { parseDidKey } from '@ainx/did-utils';
import { verifySignature } from '@ainx/crypto-utils';

const logger = new Logger('auth');
const dynamodb = new DynamoDB.DocumentClient();
const TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;

if (!TABLE_NAME) {
  throw new Error('AGENT_REGISTRATION_TABLE_NAME environment variable is required');
}

interface AuthContext {
  did: string;
  userId: string;
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  try {
    logger.info('Auth invoked', {
      methodArn: event.methodArn,
      token: event.authorizationToken ? 'present' : 'missing',
    });

    const token = event.authorizationToken;

    if (!token) {
      logger.warn('Missing authorization token');
      return generateDenyAllPolicy();
    }

    const authResult = await authenticate(token);

    if (!authResult.valid) {
      logger.warn('Authentication failed', { reason: authResult.error });
      return generateDenyAllPolicy();
    }

    logger.info('Authentication successful', {
      did: authResult.context?.did,
      userId: authResult.context?.userId,
    });

    return generateAllowPolicy(event.methodArn, authResult.context!);
  } catch (error) {
    logger.error('Error in auth handler', { error });
    return generateDenyAllPolicy();
  }
};

async function authenticate(token: string): Promise<{
  valid: boolean;
  context?: AuthContext;
  error?: string;
}> {
  const parts = token.split(':');
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid token format' };
  }

  const [did, signature, timestampStr] = parts;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { valid: false, error: 'Timestamp expired' };
  }

  let publicKey: Buffer;
  try {
    const parsed = parseDidKey(did);
    publicKey = parsed.publicKey;
  } catch {
    return { valid: false, error: 'Invalid DID format' };
  }

  const message = `auth:${did}:${timestamp}`;
  const signatureBuffer = Buffer.from(signature, 'base64');

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(publicKey, message, signatureBuffer);
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }

  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  const didQuery = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'DidIndex',
      KeyConditionExpression: 'did = :did',
      FilterExpression: 'status = :status',
      ExpressionAttributeValues: {
        ':did': did,
        ':status': 'active',
      },
    })
    .promise();

  if (!didQuery.Items || didQuery.Items.length === 0) {
    return { valid: false, error: 'DID not found or not active' };
  }

  return {
    valid: true,
    context: {
      did,
      userId: didQuery.Items[0].userId as string,
    },
  };
}

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
