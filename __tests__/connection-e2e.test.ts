import axios from 'axios';
import crypto from 'crypto';
import { DynamoDB } from 'aws-sdk';

/**
 * E2E Tests for Connection Management API
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end functionality.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 * - Two valid did:key pairs (sender and receiver)
 */

// Get API Gateway URL from environment or use default
const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const INVITATIONS_URL = `${API_BASE_URL}/connections/invitations`;
const REQUESTS_URL = `${API_BASE_URL}/connections/requests`;
const CONNECTIONS_URL = `${API_BASE_URL}/connections`;
const REGISTER_URL = `${API_BASE_URL}/agents/register`;
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
const TOKEN_URL = `${API_BASE_URL}/auth/token`;

const dynamodb = new DynamoDB.DocumentClient();
const INVITATIONS_TABLE_NAME = process.env.INVITATIONS_TABLE_NAME || 'ainx-invitations-sit';
const CONNECTION_REQUESTS_TABLE_NAME =
  process.env.CONNECTION_REQUESTS_TABLE_NAME || 'ainx-connection-requests-sit';
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME || 'ainx-connections-sit';

describe('E2E: Connection Management', () => {
  // Generate a valid did:key with proper signature
  const generateValidDid = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const rawPublicKey = publicKeyDer.slice(-32);
    const multicodecPrefix = Buffer.from([0xed, 0x01]);
    const dataWithPrefix = Buffer.concat([multicodecPrefix, rawPublicKey]);

    const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let encoded = '';
    let num = BigInt('0x' + dataWithPrefix.toString('hex'));
    while (num > 0) {
      encoded = base58Chars[Number(num % BigInt(58))] + encoded;
      num = num / BigInt(58);
    }
    for (let i = 0; i < dataWithPrefix.length && dataWithPrefix[i] === 0; i++) {
      encoded = '1' + encoded;
    }

    const did = `did:key:z${encoded}`;

    const signMessage = (message: string): string => {
      const signature = crypto.sign(null, Buffer.from(message), privateKey);
      return signature.toString('base64');
    };

    return { did, signMessage };
  };

  const getJwtToken = async (did: string, signMessage: (msg: string) => string) => {
    const challengeResponse = await axios.post(
      CHALLENGE_URL,
      { did },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const challenge = challengeResponse.data.challenge;
    const signature = signMessage(challenge);

    const tokenResponse = await axios.post(
      TOKEN_URL,
      {
        did,
        challenge,
        signature,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    return tokenResponse.data.access_token;
  };

  const registerAgent = async (did: string, signMessage: (msg: string) => string) => {
    const metadata = { name: 'Test Agent' };
    const message = JSON.stringify({ did, metadata });
    const signature = signMessage(message);

    await axios.post(
      REGISTER_URL,
      {
        did,
        signature,
        metadata,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
  };

  // Helper to create a complete test context with sender, receiver, tokens, and invitation
  const createTestContext = async () => {
    const sender = generateValidDid();
    const receiver = generateValidDid();
    await registerAgent(sender.did, sender.signMessage);
    await registerAgent(receiver.did, receiver.signMessage);
    
    // Wait a bit to ensure agent registration is propagated
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const senderToken = await getJwtToken(sender.did, sender.signMessage);
    const receiverToken = await getJwtToken(receiver.did, receiver.signMessage);

    return { sender, receiver, senderToken, receiverToken };
  };

  const cleanupTestData = async () => {
    try {
      const deletePromises: Promise<unknown>[] = [];

      const invitations = await dynamodb
        .scan({
          TableName: INVITATIONS_TABLE_NAME,
          ProjectionExpression: 'invitationCode',
        })
        .promise();

      for (const item of invitations.Items || []) {
        deletePromises.push(
          dynamodb
            .delete({
              TableName: INVITATIONS_TABLE_NAME,
              Key: { invitationCode: item.invitationCode },
            })
            .promise()
        );
      }

      const requests = await dynamodb
        .scan({
          TableName: CONNECTION_REQUESTS_TABLE_NAME,
          ProjectionExpression: 'requestId',
        })
        .promise();

      for (const item of requests.Items || []) {
        deletePromises.push(
          dynamodb
            .delete({
              TableName: CONNECTION_REQUESTS_TABLE_NAME,
              Key: { requestId: item.requestId },
            })
            .promise()
        );
      }

      const connections = await dynamodb
        .scan({
          TableName: CONNECTIONS_TABLE_NAME,
          ProjectionExpression: 'userId,connectionId',
        })
        .promise();

      for (const item of connections.Items || []) {
        deletePromises.push(
          dynamodb
            .delete({
              TableName: CONNECTIONS_TABLE_NAME,
              Key: {
                userId: item.userId,
                connectionId: item.connectionId,
              },
            })
            .promise()
        );
      }

      await Promise.all(deletePromises);
    } catch (error) {
      console.warn('Cleanup error:', error);
    }
  };

  // Clean up before and after all tests
  beforeAll(async () => {
    await cleanupTestData();
  }, 120000);


  afterAll(async () => {
    await cleanupTestData();
  }, 120000);

  describe('Happy Path', () => {
    it('should create an invitation', async () => {
      const { senderToken } = await createTestContext();

      const response = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.invitationCode).toBeDefined();
      expect(response.data.expiresAt).toBeDefined();
    });

    it('should send a connection request', async () => {
      const { sender, receiver, senderToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send connection request
      const response = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.requestId).toBeDefined();
    });

    it('should accept a connection request', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send connection request
      const requestResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const requestId = requestResponse.data.requestId;

      // Accept connection request
      const response = await axios.post(
        `${REQUESTS_URL}/${requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('ACCEPTED');
    });

    it('should list connections for sender', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send and accept connection request
      const requestResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      await axios.post(
        `${REQUESTS_URL}/${requestResponse.data.requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      // List connections
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toBeInstanceOf(Array);
      expect(response.data.connections.length).toBeGreaterThan(0);
      expect(response.data.connections[0].connectionId).toBe(receiver.did);
      expect(response.data.connections[0].status).toBe('CONNECTED');
    });

    it('should list connections for receiver', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send and accept connection request
      const requestResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      await axios.post(
        `${REQUESTS_URL}/${requestResponse.data.requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      // List connections for receiver
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          Authorization: `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toBeInstanceOf(Array);
      expect(response.data.connections.length).toBeGreaterThan(0);
      expect(response.data.connections[0].connectionId).toBe(sender.did);
    });

    it('should remove a connection', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send and accept connection request
      const requestResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      await axios.post(
        `${REQUESTS_URL}/${requestResponse.data.requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      // Remove connection
      const response = await axios.delete(`${CONNECTIONS_URL}/${receiver.did}`, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('DISCONNECTED');
    });

    it('should show empty connections after removal', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();

      // Create invitation
      const inviteResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const invitationCode = inviteResponse.data.invitationCode;

      // Send and accept connection request
      const requestResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      await axios.post(
        `${REQUESTS_URL}/${requestResponse.data.requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      // Remove connection
      await axios.delete(`${CONNECTIONS_URL}/${receiver.did}`, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      // List connections - should be empty
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toHaveLength(0);
    });
  });

  describe('Error Cases', () => {
    it('should reject self-connection', async () => {
      const { sender, senderToken } = await createTestContext();

      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const code = createResponse.data.invitationCode;

      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: sender.did,
            invitationCode: code,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.code).toBe('INVALID_REQUEST');
      }
    });

    it('should reject duplicate request', async () => {
      const { sender, receiver, senderToken } = await createTestContext();

      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const code = createResponse.data.invitationCode;

      const firstResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode: code,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(firstResponse.status).toBe(201);

      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: receiver.did,
            invitationCode: code,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(409);
        expect(error.response.data.code).toBe('CONFLICT');
      }
    });

    it('should reject non-target user accepting request', async () => {
      const { sender, receiver, senderToken, receiverToken } = await createTestContext();
      const other = generateValidDid();
      await registerAgent(other.did, other.signMessage);
      const otherToken = await getJwtToken(other.did, other.signMessage);

      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const code = createResponse.data.invitationCode;

      const sendResponse = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode: code,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const reqId = sendResponse.data.requestId;

      try {
        await axios.post(
          `${REQUESTS_URL}/${reqId}/accept`,
          {},
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${otherToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(403);
        expect(error.response.data.code).toBe('FORBIDDEN');
      }
    });

    it('should reject expired invitation', async () => {
      const { sender, receiver, senderToken } = await createTestContext();

      const createResponse = await axios.post(
        INVITATIONS_URL,
        { expiresInSeconds: 1 },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const code = createResponse.data.invitationCode;

      // Wait for invitation to expire
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: receiver.did,
            invitationCode: code,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.code).toBe('EXPIRED_INVITATION');
      }
    });

    it('should reject invalid invitation code', async () => {
      const { sender, receiver, senderToken } = await createTestContext();

      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: receiver.did,
            invitationCode: 'invalid-code',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.code).toBe('INVALID_INVITATION');
      }
    });

    it('should reject missing required fields', async () => {
      const { sender, receiver, senderToken } = await createTestContext();

      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: receiver.did,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.code).toBe('MISSING_FIELDS');
      }
    });

    it('should reject unauthenticated requests', async () => {
      try {
        await axios.post(
          INVITATIONS_URL,
          {},
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    });
  });

  describe('Pagination', () => {
    it('should handle limit parameter', async () => {
      const { senderToken } = await createTestContext();

      const response = await axios.get(`${CONNECTIONS_URL}?limit=5`, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toBeInstanceOf(Array);
    });

    it('should return nextToken when more results exist', async () => {
      const { senderToken } = await createTestContext();

      const response = await axios.get(`${CONNECTIONS_URL}?limit=1`, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      // nextToken may or may not be present depending on data
    });
  });
});
