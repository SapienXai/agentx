const axios = require('axios');
jest.mock('axios');
const { createPlan } = require('./agent_api');

// +++ FIX: The entire test suite has been rewritten to be more robust and specific. +++
describe('createPlan', () => {
  // Before each test, clear any previous mock calls to ensure test isolation
  beforeEach(() => {
    axios.post.mockClear();
    process.env.OPENAI_API_KEY = 'test_api_key';
  });

  test('should return a valid plan on the first attempt if the API response is correct', async () => {
    // Arrange: Mock a valid API response
    const validPlan = {
      searchTerm: 'Test Search',
      taskSummary: 'Perform a test task',
      strategy: 'Search and click the first link'
    };
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify(validPlan) } }]
      }
    });

    const expectedPlan = {
      ...validPlan,
      targetURL: `https://www.google.com/search?q=${encodeURIComponent(validPlan.searchTerm)}`
    };

    // Act: Call the function
    const result = await createPlan('a test goal');

    // Assert: The result should match the expected plan
    expect(result).toEqual(expectedPlan);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('should retry and then fail when the API repeatedly returns an invalid schema', async () => {
    // Arrange: Mock an API response with an invalid schema
    const invalidPlan = { some_other_key: 'value' }; // Missing required keys
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify(invalidPlan) } }]
      }
    });

    // Act & Assert: The function should reject with a specific error after retries
    await expect(createPlan('a failing goal')).rejects.toThrow(
      "AI failed to generate a valid plan after 2 attempts. Last error: Invalid plan schema: The generated JSON is missing or has invalid 'searchTerm', 'taskSummary', or 'strategy' keys."
    );

    // The API should have been called twice (1 initial + 1 retry)
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('should retry and then fail when the API call itself fails repeatedly', async () => {
    // Arrange: Mock a failing API call (e.g., network error)
    const networkError = new Error('API request failed');
    axios.post.mockRejectedValue(networkError);

    // Act & Assert: The function should reject with a specific error after retries
    await expect(createPlan('a goal with network error')).rejects.toThrow(
      'AI failed to generate a valid plan after 2 attempts. Last error: API request failed'
    );

    // The API should have been called twice
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('should succeed if the first API call fails but the retry succeeds', async () => {
    // Arrange: Mock the first call to fail (invalid schema) and the second to succeed
    const validPlan = {
      searchTerm: 'Successful Retry',
      taskSummary: 'A task that works on the second try',
      strategy: 'Retry strategy'
    };
    const invalidPlan = { bad: 'data' };
    
    axios.post
      .mockResolvedValueOnce({ // First call fails with invalid schema
        data: { choices: [{ message: { content: JSON.stringify(invalidPlan) } }] }
      })
      .mockResolvedValueOnce({ // Second call succeeds
        data: { choices: [{ message: { content: JSON.stringify(validPlan) } }] }
      });

    const expectedPlan = {
      ...validPlan,
      targetURL: `https://www.google.com/search?q=${encodeURIComponent(validPlan.searchTerm)}`
    };

    // Act: Call the function
    const result = await createPlan('a goal that will be retried');

    // Assert: The result should be the valid plan from the second call
    expect(result).toEqual(expectedPlan);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});