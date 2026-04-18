import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/src/tests/env.setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.ts'],
  moduleNameMapper: {
    '^@config/(.*)$':     '<rootDir>/src/config/$1',
    '^@middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^@modules/(.*)$':    '<rootDir>/src/modules/$1',
    '^@services/(.*)$':   '<rootDir>/src/services/$1',
    '^@jobs/(.*)$':       '<rootDir>/src/jobs/$1',
    '^@socket/(.*)$':     '<rootDir>/src/socket/$1',
    '^@utils/(.*)$':      '<rootDir>/src/utils/$1',
    '^@types/(.*)$':      '<rootDir>/src/types/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
    '!src/prisma/**',
    '!src/server.ts',
  ],
  testTimeout: 30_000,
};

export default config;
