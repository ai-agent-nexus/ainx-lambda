const path = require('path');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/e2e.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  testTimeout: 30000, // E2E 测试需要更长超时
  moduleNameMapper: {
    '^@ainx/logger$': path.resolve(__dirname, 'packages/logger/index.ts'),
    '^@ainx/shared-utils$': path.resolve(__dirname, 'packages/shared-utils/index.ts'),
    '^@ainx/crypto-utils$': path.resolve(__dirname, 'packages/crypto-utils/src/index.ts'),
    '^@ainx/did-utils$': path.resolve(__dirname, 'packages/did-utils/src/index.ts'),
  },
};
