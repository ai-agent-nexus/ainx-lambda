const path = require('path');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    'e2e\.test\.ts$', // E2E tests require real API Gateway
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    '**/*.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/coverage/**',
    '!**/__tests__/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  clearMocks: true,
  testTimeout: 10000,
  moduleNameMapper: {
    '^@ainx/connection-utils$': path.resolve(__dirname, 'packages/connection-utils/src/index.ts'),
    '^@ainx/logger$': path.resolve(__dirname, 'packages/logger/index.ts'),
    '^@ainx/shared-utils$': path.resolve(__dirname, 'packages/shared-utils/index.ts'),
    '^@ainx/crypto-utils$': path.resolve(__dirname, 'packages/crypto-utils/src/index.ts'),
    '^@ainx/did-utils$': path.resolve(__dirname, 'packages/did-utils/src/index.ts'),
  },
  transformIgnorePatterns: ['node_modules/(?!(uuid)/)'],
  extensionsToTreatAsEsm: ['.ts'],
};
