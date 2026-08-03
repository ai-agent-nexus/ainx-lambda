import axios from 'axios';
import { generateValidDid } from './utils/did';
import {
  getJwtToken,
  registerAgent,
  INVITATIONS_URL,
  REQUESTS_URL,
  CONNECTIONS_URL,
} from './utils/auth';
import { createTestContext, cleanupTestData } from './utils/test-context';

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

describe('E2E: Connection Management', () => {
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
      const { receiver, senderToken } = await createTestContext();

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
      const { receiver, senderToken, receiverToken } = await createTestContext();

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
      expect(response.data.connectionId).toBeDefined();
    });

    it('should list connections for sender', async () => {
      const { receiver, senderToken, receiverToken } = await createTestContext();

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

      const acceptResponse = await axios.post(
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

      const connectionId = acceptResponse.data.connectionId;

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
      expect(response.data.connections[0].connectionId).toBe(connectionId);
      expect(response.data.connections[0].status).toBe('CONNECTED');
    });

    it('should list connections for receiver', async () => {
      const { receiver, senderToken, receiverToken } = await createTestContext();

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

      const acceptResponse = await axios.post(
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

      const connectionId = acceptResponse.data.connectionId;

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
      expect(response.data.connections[0].connectionId).toBe(connectionId);
    });

    it('should remove a connection', async () => {
      const { receiver, senderToken, receiverToken } = await createTestContext();

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

      const acceptResponse = await axios.post(
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

      const connectionId = acceptResponse.data.connectionId;

      // Remove connection
      const response = await axios.delete(`${CONNECTIONS_URL}/${connectionId}`, {
        headers: {
          Authorization: `Bearer ${senderToken}`,
        },
        timeout: 10000,
      });

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('DISCONNECTED');
    });

    it('should show empty connections after removal', async () => {
      const { receiver, senderToken, receiverToken } = await createTestContext();

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

      const acceptResponse = await axios.post(
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

      const connectionId = acceptResponse.data.connectionId;

      // Remove connection
      await axios.delete(`${CONNECTIONS_URL}/${connectionId}`, {
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
      const { receiver, senderToken } = await createTestContext();

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
      const { receiver, senderToken } = await createTestContext();
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

      try {
        await axios.post(
          `${REQUESTS_URL}/${sendResponse.data.requestId}/accept`,
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

    it('should reject request with invalid invitation code', async () => {
      const { receiver, senderToken } = await createTestContext();

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

    it('should return 401 for missing Authorization header', async () => {
      try {
        await axios.post(
          INVITATIONS_URL,
          {},
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    });

    it('should return 403 for invalid token', async () => {
      try {
        await axios.post(
          INVITATIONS_URL,
          {},
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer invalid-token',
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(403);
      }
    });
  });
});
