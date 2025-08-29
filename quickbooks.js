const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('./database');

// QuickBooks OAuth URLs
const SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_URL = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Store the current realm ID (in production, use session or database)
let currentRealmId = null;

router.get('/status', async (req, res) => {
  try {
    // Check if we have tokens in database
    const tokens = currentRealmId ? await db.getTokens(currentRealmId) : null;
    const isConnected = tokens && new Date(tokens.expires_at) > new Date();
    
    res.json({
      connected: isConnected,
      hasCredentials: !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET),
      environment: process.env.QB_ENVIRONMENT || 'not set',
      realmId: currentRealmId,
      tokenExpiry: tokens ? tokens.expires_at : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      connected: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/test', (req, res) => {
  res.json({ message: 'Test route works!' });
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

router.get('/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>QuickBooks Connection Failed</h1>
      <p>Error: ${error}</p>
    `);
  }
  
  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing authorization code or realm ID' });
  }
  
  try {
    // Exchange authorization code for tokens
    const clientId = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    const redirectUri = process.env.QB_REDIRECT_URI || 'https://landscaping-ai-app-production.up.railway.app/api/quickbooks/callback';
    
    // Create Basic Auth header
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Save tokens to database
    await db.saveTokens(realmId, access_token, refresh_token, expires_in);
    currentRealmId = realmId;
    
    res.send(`
      <h1>QuickBooks Connected Successfully!</h1>
      <p>Company ID: ${realmId}</p>
      <p>Tokens have been saved to the database.</p>
      <p>Token expires in: ${expires_in} seconds</p>
      <p>You can close this window.</p>
      <br>
      <a href="/api/quickbooks/status">Check Connection Status</a>
    `);
    
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.status(500).send(`
      <h1>Token Exchange Failed</h1>
      <p>Error: ${error.message}</p>
      <p>Please try again.</p>
    `);
  }
});

// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
  try {
    if (!currentRealmId) {
      return res.status(400).json({ error: 'No realm ID available' });
    }
    
    const tokens = await db.getTokens(currentRealmId);
    if (!tokens) {
      return res.status(404).json({ error: 'No tokens found' });
    }
    
    const clientId = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    const tokenResponse = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }),
      {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Save new tokens
    await db.saveTokens(currentRealmId, access_token, refresh_token, expires_in);
    
    res.json({
      success: true,
      message: 'Tokens refreshed',
      expiresIn: expires_in
    });
    
  } catch (error) {
    console.error('Token refresh error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// Test QuickBooks API connection
router.get('/company-info', async (req, res) => {
  try {
    if (!currentRealmId) {
      return res.status(400).json({ error: 'Not connected to QuickBooks' });
    }
    
    const tokens = await db.getTokens(currentRealmId);
    if (!tokens) {
      return res.status(404).json({ error: 'No tokens found' });
    }
    
    // Check if token is expired
    if (new Date(tokens.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Token expired, please refresh' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    // Get company info from QuickBooks
    const response = await axios.get(
      `${baseUrl}/v3/company/${currentRealmId}/companyinfo/${currentRealmId}`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json'
        }
      }
    );
    
    res.json({
      success: true,
      company: response.data
    });
    
  } catch (error) {
    console.error('Company info error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get company info' });
  }
});

module.exports = router;// OAuth implementation complete
