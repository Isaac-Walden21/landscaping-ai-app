const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    connected: false,
    hasCredentials: !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET),
    environment: process.env.QB_ENVIRONMENT || 'not set',
    timestamp: new Date().toISOString()
  });
});

router.get('/test', (req, res) => {
  res.json({ message: 'Test route works' });
});

router.get('/auth', (req, res) => {
  if (!process.env.QB_CLIENT_ID || !process.env.QB_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'QuickBooks credentials not configured',
      message: 'Please add QB_CLIENT_ID and QB_CLIENT_SECRET to environment variables'
    });
  }
  
  const clientId = process.env.QB_CLIENT_ID;
  const redirectUri = process.env.QB_REDIRECT_URI || 'https://landscaping-ai-app-production.up.railway.app/api/quickbooks/callback';
  const scope = 'com.intuit.quickbooks.accounting';
  const responseType = 'code';
  const state = 'testState123';
  
  const authUrl = `https://appcenter.intuit.com/connect/oauth2?` +
    `client_id=${clientId}` +
    `&scope=${scope}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=${responseType}` +
    `&state=${state}`;
  
  res.redirect(authUrl);
});

router.get('/callback', (req, res) => {
  const { code, realmId, state, error } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>QuickBooks Connection Failed</h1>
      <p>Error: ${error}</p>
    `);
  }
  
  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }
  
  res.send(`
    <h1>QuickBooks Authorization Received!</h1>
    <p>Authorization code: ${code.substring(0, 10)}...</p>
    <p>Company ID: ${realmId}</p>
    <p>You can close this window.</p>
  `);
});

module.exports = router;
