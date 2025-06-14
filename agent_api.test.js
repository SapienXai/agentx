const axios = require('axios');
jest.mock('axios');
const { createPlan } = require('./agent_api');

describe('createPlan', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test';
  });

  test('returns parsed plan when API response is valid', async () => {
    const plan = { targetURL: 'http://x.com', taskSummary: 'a', strategy: 'b' };
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(plan) } }] } });
    await expect(createPlan('goal')).resolves.toEqual(plan);
  });

  test('throws when response lacks required keys', async () => {
    const invalid = { foo: 'bar' };
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(invalid) } }] } });
    await expect(createPlan('goal')).rejects.toThrow();
  });
});
