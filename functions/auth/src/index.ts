import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { Logger } from '@ainx/logger';
import { parseDidKey } from '@ainx/did-utils';
import { verifySignature } from '@ainx/crypto-utils';

const logger = new Logger('auth');
const dynamodb = new DynamoDB.DocumentClient();
const TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;
const NONCE_TABLE_NAME = process.env.NONCE_TABLE_NAME!;

if (!TABLE_NAME) {
  throw new Error('AGENT_REGISTRATION_TABLE_NAME environment variable is required');
}

if (!NONCE_TABLE_NAME) {
  throw new Error('NONCE_TABLE_NAME environment variable is required');
}

interface AuthContext {
  did: string;
  userId: string;
}

interface ParsedToken {
  did: string;
  signature: string;
  timestamp: number;
  nonce: string;
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

    const authResult = await authenticate(token, event.methodArn);

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

function parseToken(token: string): ParsedToken | null {
  // Token format: did:key:{did}:{signature}:{timestamp}:{nonce}
  // Example: did:key:z6Mk...:dGVzdHNpZ25hdHVyZQ==:1234567890:abc123

  // Must start with did:key:
  if (!token.startsWith('did:key:')) {
    return null;
  }

  // Remove did:key: prefix
  const withoutPrefix = token.slice(8); // 'did:key:'.length === 8

  // Split remaining parts
  const parts = withoutPrefix.split(':');

  // Need: did + signature + timestamp + nonce = 4 parts minimum
  // DID itself might contain colons in theory, but did:key format is simple
  if (parts.length < 4) {
    return null;
  }

  // Extract from end: nonce (last), timestamp (second last), signature (third last)
  const nonce = parts.pop()!;
  const timestampStr = parts.pop()!;
  const signature = parts.pop()!;
  const did = 'did:key:' + parts.join(':');

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return null;
  }

  return { did, signature, timestamp, nonce };
}

async function authenticate(
  token: string,
  _methodArn: string
): Promise<{
  valid: boolean;
  context?: AuthContext;
  error?: string;
}> {
  const parsed = parseToken(token);
  if (!parsed) {
    return { valid: false, error: 'Invalid token format' };
  }

  const { did, signature, timestamp, nonce } = parsed;

  // Validate timestamp (5 minute window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { valid: false, error: 'Timestamp expired' };
  }

  // Validate nonce (check if already used)
  const nonceValid = await validateNonce(nonce);
  if (!nonceValid) {
    return { valid: false, error: 'Nonce already used or invalid' };
  }

  // Parse DID and get public key
  let publicKey: Buffer;
  try {
    const parsed = parseDidKey(did);
    publicKey = parsed.publicKey;
  } catch {
    return { valid: false, error: 'Invalid DID format' };
  }

  // Build message for signature verification
  // Format: auth:{did}:{timestamp}:{nonce}
  const message = `auth:${did}:${timestamp}:${nonce}`;
  const signatureBuffer = Buffer.from(signature, 'base64');

  // Verify signature
  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(publicKey, message, signatureBuffer);
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }

  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Check if DID exists and is active
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

async function validateNonce(nonce: string): Promise<boolean> {
  try {
    // Check if nonce exists
    const result = await dynamodb
      .get({
        TableName: NONCE_TABLE_NAME,
        Key: { nonce },
      })
      .promise();

    if (result.Item) {
      // Nonce already used
      return false;
    }

    // Store nonce with TTL (5 minutes)
    const ttl = Math.floor(Date.now() / 1000) + 300;
    await dynamodb
      .put({
        TableName: NONCE_TABLE_NAME,
        Item: {
          nonce,
          ttl,
          createdAt: new Date().toISOString(),
        },
      })
      .promise();

    return true;
  } catch (error) {
    logger.error('Error validating nonce', { error, nonce });
    return false;
  }
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
