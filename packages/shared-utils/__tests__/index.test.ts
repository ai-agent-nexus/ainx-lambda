import { formatResponse, validateInput, generateId, parseBody } from '../index';

describe('formatResponse', () => {
  it('should format response with status code and body', () => {
    const result = formatResponse(200, { message: 'Success' });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(JSON.stringify({ message: 'Success' }));
  });

  it('should include CORS headers', () => {
    const result = formatResponse(200, { message: 'Success' });

    expect(result.headers).toBeDefined();
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(result.headers?.['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('should handle error status codes', () => {
    const result = formatResponse(500, { error: 'Internal error' });

    expect(result.statusCode).toBe(500);
    expect(result.body).toBe(JSON.stringify({ error: 'Internal error' }));
  });
});

describe('validateInput', () => {
  it('should return valid for complete input', () => {
    const input = { name: 'John', email: 'john@example.com' };
    const result = validateInput(input, ['name', 'email']);

    expect(result.valid).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it('should return invalid for missing fields', () => {
    const input = { name: 'John' };
    const result = validateInput(input, ['name', 'email']);

    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('email');
  });

  it('should return invalid for multiple missing fields', () => {
    const input = {};
    const result = validateInput(input, ['name', 'email', 'age']);

    expect(result.valid).toBe(false);
    expect(result.missingFields).toHaveLength(3);
    expect(result.missingFields).toContain('name');
    expect(result.missingFields).toContain('email');
    expect(result.missingFields).toContain('age');
  });

  it('should handle empty required fields array', () => {
    const input = { name: 'John' };
    const result = validateInput(input, []);

    expect(result.valid).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it('should treat empty string as missing', () => {
    const input = { name: '', email: 'john@example.com' };
    const result = validateInput(input, ['name', 'email']);

    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('name');
  });
});

describe('generateId', () => {
  it('should generate a unique ID', () => {
    const id1 = generateId();
    const id2 = generateId();

    expect(id1).not.toBe(id2);
  });

  it('should generate ID with timestamp and random parts', () => {
    const id = generateId();
    const parts = id.split('-');

    expect(parts.length).toBe(2);
    expect(Number(parts[0])).toBeGreaterThan(0); // timestamp
    expect(parts[1]).toHaveLength(9); // random part
  });

  it('should generate different IDs in sequence', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }

    expect(ids.size).toBe(100);
  });
});

describe('parseBody', () => {
  it('should parse valid JSON string', () => {
    const body = '{"name":"John","age":30}';
    const result = parseBody<Record<string, unknown>>(body);

    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('should return null for null input', () => {
    const result = parseBody<Record<string, unknown>>(null);

    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const body = 'invalid json';
    const result = parseBody<Record<string, unknown>>(body);

    expect(result).toBeNull();
  });

  it('should parse nested JSON objects', () => {
    const body = '{"user":{"name":"John","email":"john@example.com"}}';
    const result = parseBody<Record<string, unknown>>(body);

    expect(result).toEqual({
      user: {
        name: 'John',
        email: 'john@example.com',
      },
    });
  });

  it('should parse JSON arrays', () => {
    const body = '[1,2,3,4,5]';
    const result = parseBody<number[]>(body);

    expect(result).toEqual([1, 2, 3, 4, 5]);
  });
});
