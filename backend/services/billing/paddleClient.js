const axios = require('axios');

function getPaddleBaseUrl() {
  const env = (process.env.PADDLE_ENV || 'sandbox').toLowerCase();
  return env === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

function getPaddleApiKey() {
  return process.env.PADDLE_API_KEY;
}

async function paddleRequest(method, path, data) {
  const apiKey = getPaddleApiKey();
  if (!apiKey) {
    throw new Error('Missing PADDLE_API_KEY');
  }

  const url = `${getPaddleBaseUrl()}${path}`;
  const res = await axios.request({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  return res.data;
}

module.exports = {
  getPaddleBaseUrl,
  paddleRequest
};

