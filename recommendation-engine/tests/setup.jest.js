/**
 * Global Jest setup.
 *
 * Unit tests (service/utils layer) should never open a real socket to
 * Redis or Postgres — that belongs in integration tests run against a
 * docker-compose'd test environment (see README, "Testing" section).
 *
 * We mock `ioredis` at the module level so anything that transitively
 * requires `src/config/redis.js` gets a no-op in-memory-ish stub instead
 * of attempting ECONNREFUSED retries during `npm test`.
 */

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  }));
});
