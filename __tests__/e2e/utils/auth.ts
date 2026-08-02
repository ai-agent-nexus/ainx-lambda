import axios from 'axios';

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';

export const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
export const TOKEN_URL = `${API_BASE_URL}/auth/token`;
export const REGISTER_URL = `${API_BASE_URL}/agents/register`;
export const REFRESH_URL = `${API_BASE_URL}/auth/refresh`;
export const AUTH_REVOKE_URL = `${API_BASE_URL}/auth/revoke`;
export const AGENT_REVOKE_URL = `${API_BASE_URL}/agents/revoke`;
export const ROTATE_KEY_URL = `${API_BASE_URL}/agents/rotate-key`;
export const INVITATIONS_URL = `${API_BASE_URL}/connections/invitations`;
export const REQUESTS_URL = `${API_BASE_URL}/connections/requests`;
export const CONNECTIONS_URL = `${API_BASE_URL}/connections`;
export const MESSAGES_URL = `${API_BASE_URL}/connections`;

/**
 * Register a DID with the agent registration service
 */
export async function registerAgent(
  did: string,
  signMessage: (msg: string) => string
): Promise<void> {
  const metadata = { name: 'Test Agent' };
  const message = JSON.stringify({ did, metadata });
  const signature = signMessage(message);

  try {
    await axios.post(
      REGISTER_URL,
      { did, signature, metadata },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error('registerAgent failed:', {
        status: error.response.status,
        data: error.response.data,
      });
    }
    throw error;
  }
}

/**
 * Get JWT token for a DID
 */
export async function getJwtToken(
  did: string,
  signMessage: (msg: string) => string
): Promise<string> {
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
    { did, challenge, signature },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );

  return tokenResponse.data.access_token;
}

/**
 * Get token pair (access token + refresh token)
 */
export async function getTokenPair(
  did: string,
  signMessage: (msg: string) => string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
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
    { did, challenge, signature },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );

  return {
    accessToken: tokenResponse.data.access_token,
    refreshToken: tokenResponse.data.refresh_token,
    expiresIn: tokenResponse.data.expires_in,
  };
}
