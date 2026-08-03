import axios from 'axios';
import { generateValidDid } from './utils/did';
import { getJwtToken, registerAgent, MESSAGES_URL } from './utils/auth';
import { createConnection } from './utils/test-context';

/**
 * E2E Tests for Message API
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end functionality.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 * - Two valid did:key pairs (sender and receiver)
 */

describe('E2E: Message Management', () => {
  describe('Happy Path: Send Message', () => {
    it('should successfully send a message between connected agents', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      const messageResponse = await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: 'Hello, this is an E2E test message!',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.data.success).toBe(true);
      expect(messageResponse.data.messageId).toBeDefined();
    });

    it('should accept minimal message content', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      const messageResponse = await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: 'Hi',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.data.success).toBe(true);
    });
  });

  describe('Happy Path: List Messages', () => {
    it('should list messages for a connection', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, receiverToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // Send a message
      await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: 'Test message for listing',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      // List messages as receiver
      const listResponse = await axios.get(`${MESSAGES_URL}/${connectionId}/messages`, {
        headers: {
          Authorization: `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(listResponse.status).toBe(200);
      expect(listResponse.data.messages).toBeDefined();
      expect(listResponse.data.messages.length).toBeGreaterThan(0);
    });

    it('should support pagination with limit parameter', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, receiverToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // Send multiple messages
      for (let i = 0; i < 3; i++) {
        await axios.post(
          `${MESSAGES_URL}/${connectionId}/messages`,
          {
            content: `Message ${i + 1}`,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
      }

      // List with limit=1
      const listResponse = await axios.get(`${MESSAGES_URL}/${connectionId}/messages?limit=1`, {
        headers: {
          Authorization: `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(listResponse.status).toBe(200);
      expect(listResponse.data.messages).toHaveLength(1);
    });
  });

  describe('Happy Path: Complete Message Flow', () => {
    it('should send and retrieve messages in both directions', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, receiverToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // Sender sends message to receiver
      const sendResponse = await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: 'Hello from sender!',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(sendResponse.status).toBe(201);
      const messageId = sendResponse.data.messageId;

      // Receiver lists messages
      const listResponse = await axios.get(`${MESSAGES_URL}/${connectionId}/messages`, {
        headers: {
          Authorization: `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(listResponse.status).toBe(200);
      const messages = listResponse.data.messages;
      expect(messages.some((msg: any) => msg.messageId === messageId)).toBe(true);
      expect(messages.some((msg: any) => msg.content === 'Hello from sender!')).toBe(true);
    });
  });

  describe('Error Cases: Send Message', () => {
    it('should return 401 for missing Authorization header', async () => {
      const { did: receiverDid } = generateValidDid();

      try {
        await axios.post(
          `${MESSAGES_URL}/${receiverDid}/messages`,
          {
            content: 'Test message',
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );
        fail('Expected request to fail');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    });

    it('should return 403 for unauthorized connection', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();
      const { did: unauthorizedDid, signMessage: unauthorizedSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);
      await registerAgent(unauthorizedDid, unauthorizedSign);

      // Create connection between sender and receiver
      const { connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // Unauthorized user tries to send message
      const unauthorizedToken = await getJwtToken(unauthorizedDid, unauthorizedSign);

      try {
        await axios.post(
          `${MESSAGES_URL}/${connectionId}/messages`,
          {
            content: 'Unauthorized message',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${unauthorizedToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Expected request to fail');
      } catch (error: any) {
        expect(error.response.status).toBe(403);
      }
    });

    it('should return 400 for empty message content', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      try {
        await axios.post(
          `${MESSAGES_URL}/${connectionId}/messages`,
          {
            content: '',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${senderToken}`,
            },
            timeout: 10000,
          }
        );
        fail('Expected request to fail');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
      }
    });
  });

  describe('Error Cases: List Messages', () => {
    it('should return 401 for missing Authorization header', async () => {
      const { did: connectionId } = generateValidDid();

      try {
        await axios.get(`${MESSAGES_URL}/${connectionId}/messages`, {
          timeout: 10000,
        });
        fail('Expected request to fail');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    });

    it('should return 403 for unauthorized connection', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();
      const { did: unauthorizedDid, signMessage: unauthorizedSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);
      await registerAgent(unauthorizedDid, unauthorizedSign);

      // Create connection between sender and receiver
      const { connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // Unauthorized user tries to list messages
      const unauthorizedToken = await getJwtToken(unauthorizedDid, unauthorizedSign);

      try {
        await axios.get(`${MESSAGES_URL}/${connectionId}/messages`, {
          headers: {
            Authorization: `Bearer ${unauthorizedToken}`,
          },
          timeout: 10000,
        });
        fail('Expected request to fail');
      } catch (error: any) {
        expect(error.response.status).toBe(403);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message list', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { receiverToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      // List messages without sending any
      const listResponse = await axios.get(`${MESSAGES_URL}/${connectionId}/messages`, {
        headers: {
          Authorization: `Bearer ${receiverToken}`,
        },
        timeout: 10000,
      });

      expect(listResponse.status).toBe(200);
      expect(listResponse.data.messages).toHaveLength(0);
      expect(listResponse.data.nextToken).toBeUndefined();
    });

    it('should handle large message content', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      const largeContent = 'A'.repeat(1000);

      const messageResponse = await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: largeContent,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.data.success).toBe(true);
    });
  });

  describe('Security', () => {
    it('should handle SQL injection attempt in message content', async () => {
      const { did: senderDid, signMessage: senderSign } = generateValidDid();
      const { did: receiverDid, signMessage: receiverSign } = generateValidDid();

      await registerAgent(senderDid, senderSign);
      await registerAgent(receiverDid, receiverSign);

      const { senderToken, connectionId } = await createConnection(
        senderDid,
        senderSign,
        receiverDid,
        receiverSign
      );

      const maliciousContent = "'; DROP TABLE messages; --";

      const messageResponse = await axios.post(
        `${MESSAGES_URL}/${connectionId}/messages`,
        {
          content: maliciousContent,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${senderToken}`,
          },
          timeout: 10000,
        }
      );

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.data.success).toBe(true);
    });
  });
});
