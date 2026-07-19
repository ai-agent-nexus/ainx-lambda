import { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Format a standard API Gateway response
 */
export function formatResponse(
  statusCode: number,
  body: Record<string, unknown>
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Validate that required fields are present in the input
 */
export function validateInput(
  input: Record<string, unknown>,
  requiredFields: string[]
): { valid: boolean; missingFields: string[] } {
  const missingFields = requiredFields.filter((field) => !input[field]);
  
  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Parse and validate JSON body from API Gateway event
 */
export function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
