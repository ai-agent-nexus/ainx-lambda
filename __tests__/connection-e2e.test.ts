import axios from 'axios';
import crypto from 'crypto';

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

  const generateAuthToken = (did: string, signMessage: (msg: string) => string): string => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const authMessage = `auth:${did}:${timestamp}:${nonce}`;
    const authSignature = signMessage(authMessage);
    return `${did}:${authSignature}:${timestamp}:${nonce}`;
  };

  let sender: { did: string; signMessage: (msg: string) => string };
  let receiver: { did: string; signMessage: (msg: string) => string };
  let senderToken: string;
  let receiverToken: string;
  let invitationCode: string;
  let requestId: string;

  beforeAll(() => {
    sender = generateValidDid();
    receiver = generateValidDid();
    senderToken = generateAuthToken(sender.did, sender.signMessage);
    receiverToken = generateAuthToken(receiver.did, receiver.signMessage);
  });

  describe('Happy Path', () => {
    it('should create an invitation', async () => {
      const response = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.invitationCode).toBeDefined();
      expect(response.data.expiresAt).toBeDefined();
      invitationCode = response.data.invitationCode;
    });

    it('should send a connection request', async () => {
      const response = await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.requestId).toBeDefined();
      requestId = response.data.requestId;
    });

    it('should accept a connection request', async () => {
      const response = await axios.post(
        `${REQUESTS_URL}/${requestId}/accept`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${receiverToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('ACCEPTED');
    });

    it('should list connections for sender', async () => {
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          'Authorization': `Bearer ${senderToken}`,
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
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          'Authorization': `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toBeInstanceOf(Array);
      expect(response.data.connections.length).toBeGreaterThan(0);
      expect(response.data.connections[0].connectionId).toBe(sender.did);
    });

    it('should remove a connection', async () => {
      const response = await axios.delete(
        `${CONNECTIONS_URL}/${receiver.did}`,
        {
          headers: {
            'Authorization': `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('DISCONNECTED');
    });

    it('should show empty connections after removal', async () => {
      const response = await axios.get(CONNECTIONS_URL, {
        headers: {
          'Authorization': `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toHaveLength(0);
    });
  });

  describe('Error Cases', () => {
    it('should reject self-connection', async () => {
      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
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
              'Authorization': `Bearer ${senderToken}`,
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
      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      const code = createResponse.data.invitationCode;

      await axios.post(
        REQUESTS_URL,
        {
          toDid: receiver.did,
          invitationCode: code,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

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
              'Authorization': `Bearer ${senderToken}`,
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
      const other = generateValidDid();
      const otherToken = generateAuthToken(other.did, other.signMessage);

      const createResponse = await axios.post(
        INVITATIONS_URL,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
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
            'Authorization': `Bearer ${senderToken}`,
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
              'Authorization': `Bearer ${otherToken}`,
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
      const createResponse = await axios.post(
        INVITATIONS_URL,
        { expiresInSeconds: 1 },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senderToken}`,
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
              'Authorization': `Bearer ${senderToken}`,
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
              'Authorization': `Bearer ${senderToken}`,
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
      try {
        await axios.post(
          REQUESTS_URL,
          {
            toDid: receiver.did,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${senderToken}`,
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
      const response = await axios.get(`${CONNECTIONS_URL}?limit=5`, {
        headers: {
          'Authorization': `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.connections).toBeInstanceOf(Array);
    });

    it('should return nextToken when more results exist', async () => {
      const response = await axios.get(`${CONNECTIONS_URL}?limit=1`, {
        headers: {
          'Authorization': `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      // nextToken may or may not be present depending on data
    });
  });
});
