import {
  generateInvitationCode,
  isValidInvitationCode,
  calculateInvitationExpiration,
  isInvitationExpired,
  generateRequestId,
  isValidDid,
  CONNECTION_LIMIT,
  DEFAULT_INVITATION_TTL_SECONDS,
  MAX_INVITATION_TTL_SECONDS,
} from '../../packages/connection-utils/src/index';

describe('connection-utils', () => {
  describe('generateInvitationCode', () => {
    it('should generate valid UUID v4', () => {
      const code = generateInvitationCode();
      expect(isValidInvitationCode(code)).toBe(true);
    });

    it('should generate unique codes', () => {
      const code1 = generateInvitationCode();
      const code2 = generateInvitationCode();
      expect(code1).not.toBe(code2);
    });
  });

  describe('isValidInvitationCode', () => {
    it('should validate correct UUID', () => {
      expect(isValidInvitationCode('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should reject invalid format', () => {
      expect(isValidInvitationCode('invalid')).toBe(false);
      expect(isValidInvitationCode('')).toBe(false);
    });
  });

  describe('calculateInvitationExpiration', () => {
    it('should use default TTL when not specified', () => {
      const result = calculateInvitationExpiration();
      const now = Math.floor(Date.now() / 1000);
      expect(result.ttl).toBeGreaterThan(now);
      expect(result.ttl).toBeLessThanOrEqual(now + DEFAULT_INVITATION_TTL_SECONDS + 1);
    });

    it('should use custom TTL', () => {
      const customSeconds = 3600;
      const result = calculateInvitationExpiration(customSeconds);
      const now = Math.floor(Date.now() / 1000);
      expect(result.ttl).toBeGreaterThan(now);
      expect(result.ttl).toBeLessThanOrEqual(now + customSeconds + 1);
    });

    it('should cap at max TTL', () => {
      const result = calculateInvitationExpiration(MAX_INVITATION_TTL_SECONDS + 1000);
      const now = Math.floor(Date.now() / 1000);
      expect(result.ttl).toBeLessThanOrEqual(now + MAX_INVITATION_TTL_SECONDS + 1);
    });

    it('should reject negative or zero TTL', () => {
      const result = calculateInvitationExpiration(-100);
      const now = Math.floor(Date.now() / 1000);
      expect(result.ttl).toBeGreaterThan(now);
    });
  });

  describe('isInvitationExpired', () => {
    it('should return false for future date', () => {
      const future = new Date(Date.now() + 10000).toISOString();
      expect(isInvitationExpired(future)).toBe(false);
    });

    it('should return true for past date', () => {
      const past = new Date(Date.now() - 10000).toISOString();
      expect(isInvitationExpired(past)).toBe(true);
    });
  });

  describe('generateRequestId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
      expect(id1.startsWith('req_')).toBe(true);
    });
  });

  describe('isValidDid', () => {
    it('should validate did:key format', () => {
      expect(isValidDid('did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ')).toBe(true);
    });

    it('should reject invalid DID', () => {
      expect(isValidDid('invalid')).toBe(false);
      expect(isValidDid('')).toBe(false);
    });
  });

  describe('constants', () => {
    it('should have correct values', () => {
      expect(CONNECTION_LIMIT).toBe(100);
      expect(DEFAULT_INVITATION_TTL_SECONDS).toBe(1800);
      expect(MAX_INVITATION_TTL_SECONDS).toBe(86400);
    });
  });
});
