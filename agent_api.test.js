const axios = require('axios');
jest.mock('axios');
const { createPlan } = require('./agent_api');

describe('createPlan', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test';
  });

  test('returns parsed plan when API response is valid', async () => {
    const apiPlan = { searchTerm: 'x', taskSummary: 'a', strategy: 'b' };
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(apiPlan) } }] } });
    const expected = { ...apiPlan, targetURL: 'https://www.google.com/search?q=x' };
    await expect(createPlan('goal')).resolves.toEqual(expected);
  });

  test('throws when response lacks required keys', async () => {
    const invalid = { foo: 'bar' };
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(invalid) } }] } });
    await expect(createPlan('goal')).rejects.toThrow();
  });
});
