const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('./database');

// QuickBooks OAuth URLs
const SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_URL = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Middleware to authenticate user from session token
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.replace('Bearer ', '') || req.query.session_token;
  
  if (!sessionToken) {
    return res.status(401).json({ error: 'No session token provided' });
  }
  
  const user = await db.getUserBySessionToken(sessionToken);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  
  req.user = user;
  next();
}

// Helper function to get valid tokens for a specific user
async function getValidUserTokens(userId) {
  const tokens = await db.getUserTokens(userId);
  if (!tokens) {
    return null;
  }
  
  // Check if token is expired or about to expire (within 5 minutes)
  const expiryTime = new Date(tokens.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60000);
  
  if (expiryTime < fiveMinutesFromNow) {
    console.log(`Token expired or expiring soon for user ${userId}, refreshing...`);
    
    try {
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
      
      // Save new tokens for this user
      await db.saveUserTokens(userId, tokens.realm_id, access_token, refresh_token, expires_in);
      
      // Return the new tokens
      return await db.getUserTokens(userId);
    } catch (error) {
      console.error(`Failed to refresh token for user ${userId}:`, error);
      return null;
    }
  }
  
  return tokens;
}

// Status route - shows connection status for the authenticated user
router.get('/status', authenticateUser, async (req, res) => {
  try {
    const tokens = await getValidUserTokens(req.user.id);
    const isConnected = tokens !== null;
    
    res.json({
      connected: isConnected,
      hasCredentials: !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET),
      environment: process.env.QB_ENVIRONMENT || 'not set',
      realmId: tokens?.realm_id || null,
      tokenExpiry: tokens?.expires_at || null,
      businessName: req.user.business_name,
      userEmail: req.user.email,
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

// Auth route - initiates OAuth for a specific user
router.get('/auth', authenticateUser, (req, res) => {
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
  // Include user ID in state for callback
  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    timestamp: Date.now()
  })).toString('base64');
  
  const authUrl = `https://appcenter.intuit.com/connect/oauth2?` +
    `client_id=${clientId}` +
    `&scope=${scope}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=${responseType}` +
    `&state=${state}`;
  
  res.redirect(authUrl);
});

// Callback route - handles OAuth callback and saves tokens for specific user
router.get('/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>QuickBooks Connection Failed</h1>
      <p>Error: ${error}</p>
      <script>
        setTimeout(() => window.close(), 3000);
      </script>
    `);
  }
  
  if (!code || !realmId || !state) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  try {
    // Decode state to get user ID
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;
    
    if (!userId) {
      throw new Error('User ID not found in state');
    }
    
    // Exchange authorization code for tokens
    const clientId = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    const redirectUri = process.env.QB_REDIRECT_URI || 'https://landscaping-ai-app-production.up.railway.app/api/quickbooks/callback';
    
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
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
    
    // Save tokens for this specific user
    await db.saveUserTokens(userId, realmId, access_token, refresh_token, expires_in);
    
    // Get user info for display
    const user = await db.getUserById(userId);
    
    res.send(`
      <h1>QuickBooks Connected Successfully!</h1>
      <p>Business: ${user.business_name || user.email}</p>
      <p>QuickBooks Company ID: ${realmId}</p>
      <p>Your QuickBooks account is now connected to your LandscapingAI account.</p>
      <script>
        // Post message to parent window if in iframe/popup
        if (window.opener) {
          window.opener.postMessage({ 
            type: 'quickbooks-connected', 
            success: true 
          }, '*');
        }
        setTimeout(() => window.close(), 3000);
      </script>
    `);
    
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.status(500).send(`
      <h1>Connection Failed</h1>
      <p>Error: ${error.message}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ 
            type: 'quickbooks-connected', 
            success: false,
            error: '${error.message}'
          }, '*');
        }
        setTimeout(() => window.close(), 5000);
      </script>
    `);
  }
});

// Get company info - for authenticated user's QuickBooks
router.get('/company-info', authenticateUser, async (req, res) => {
  try {
    const tokens = await getValidUserTokens(req.user.id);
    if (!tokens) {
      return res.status(401).json({ error: 'QuickBooks not connected for this account' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    const response = await axios.get(
      `${baseUrl}/v3/company/${tokens.realm_id}/companyinfo/${tokens.realm_id}`,
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

// Create customer - for authenticated user's QuickBooks
router.post('/create-customer', authenticateUser, async (req, res) => {
  try {
    const { customer_info } = req.body;
    
    const tokens = await getValidUserTokens(req.user.id);
    if (!tokens) {
      return res.status(401).json({ error: 'QuickBooks not connected for this account' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    // Check if customer exists by email
    let customerId = null;
    if (customer_info.email) {
      try {
        const searchResponse = await axios.get(
          `${baseUrl}/v3/company/${tokens.realm_id}/query?query=select * from Customer where PrimaryEmailAddr='${customer_info.email}'`,
          {
            headers: {
              'Authorization': `Bearer ${tokens.access_token}`,
              'Accept': 'application/json'
            }
          }
        );
        
        if (searchResponse.data.QueryResponse?.Customer?.length > 0) {
          customerId = searchResponse.data.QueryResponse.Customer[0].Id;
        }
      } catch (searchError) {
        console.log('Customer not found, will create new');
      }
    }
    
    let customer;
    if (customerId) {
      // Update existing customer
      const updateResponse = await axios.post(
        `${baseUrl}/v3/company/${tokens.realm_id}/customer`,
        {
          Id: customerId,
          sparse: true,
          DisplayName: customer_info.name,
          PrimaryPhone: customer_info.phone ? {
            FreeFormNumber: customer_info.phone
          } : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        }
      );
      customer = updateResponse.data.Customer;
    } else {
      // Create new customer
      const customerData = {
        DisplayName: customer_info.name || 'Unknown Customer'
      };
      
      if (customer_info.email) {
        customerData.PrimaryEmailAddr = {
          Address: customer_info.email
        };
      }
      
      if (customer_info.phone) {
        customerData.PrimaryPhone = {
          FreeFormNumber: customer_info.phone
        };
      }
      
      if (customer_info.address || customer_info.city || customer_info.state || customer_info.zip) {
        customerData.BillAddr = {
          Line1: customer_info.address || '',
          City: customer_info.city || '',
          CountrySubDivisionCode: customer_info.state || '',
          PostalCode: customer_info.zip || ''
        };
      }
      
      const createResponse = await axios.post(
        `${baseUrl}/v3/company/${tokens.realm_id}/customer`,
        customerData,
        {
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        }
      );
      customer = createResponse.data.Customer;
    }
    
    res.json({
      success: true,
      customer: customer,
      isNew: !customerId
    });
    
  } catch (error) {
    console.error('Create customer error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create customer',
      details: error.response?.data || error.message
    });
  }
});

// Create estimate - for authenticated user's QuickBooks
router.post('/create-estimate', authenticateUser, async (req, res) => {
  try {
    const { customerId, estimate_data } = req.body;
    
    const tokens = await getValidUserTokens(req.user.id);
    if (!tokens) {
      return res.status(401).json({ error: 'QuickBooks not connected for this account' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    // Build line items
    const lineItems = [];
    
    if (estimate_data.serviceItems?.length > 0) {
      estimate_data.serviceItems.forEach(item => {
        lineItems.push({
          DetailType: 'SalesItemLineDetail',
          Amount: item.subtotal,
          Description: `${item.description} - ${item.quantity} ${item.unit} @ $${item.rate}/${item.unit}`,
          SalesItemLineDetail: {
            ItemRef: {
              value: '1',
              name: 'Services'
            }
          }
        });
      });
    }
    
    if (estimate_data.materialItems?.length > 0) {
      estimate_data.materialItems.forEach(item => {
        lineItems.push({
          DetailType: 'SalesItemLineDetail',
          Amount: item.subtotal,
          Description: `${item.description} - ${item.quantity} ${item.unit}`,
          SalesItemLineDetail: {
            ItemRef: {
              value: '2',
              name: 'Materials'
            }
          }
        });
      });
    }
    
    if (lineItems.length === 0) {
      lineItems.push({
        DetailType: 'SalesItemLineDetail',
        Amount: estimate_data.pricing?.total || 0,
        Description: estimate_data.projectInfo?.summary || 'Landscaping Services',
        SalesItemLineDetail: {
          ItemRef: {
            value: '1',
            name: 'Services'
          }
        }
      });
    }
    
    const estimatePayload = {
      Line: lineItems,
      CustomerRef: {
        value: customerId
      },
      TxnDate: new Date().toISOString().split('T')[0],
      ExpirationDate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
      CustomerMemo: {
        value: estimate_data.projectInfo?.summary || 'Landscaping Estimate'
      }
    };
    
    const response = await axios.post(
      `${baseUrl}/v3/company/${tokens.realm_id}/estimate`,
      estimatePayload,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Save to local database with user ID
    await db.pool.query(
      `INSERT INTO estimates (user_id, customer_name, customer_email, estimate_data, quickbooks_estimate_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        estimate_data.customer_name || 'Unknown',
        estimate_data.customer_email || '',
        JSON.stringify(estimate_data),
        response.data.Estimate.Id
      ]
    );
    
    res.json({
      success: true,
      estimate: response.data.Estimate
    });
    
  } catch (error) {
    console.error('Create estimate error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create estimate',
      details: error.response?.data || error.message
    });
  }
});

// Get estimates - for authenticated user's QuickBooks
router.get('/estimates', authenticateUser, async (req, res) => {
  try {
    const tokens = await getValidUserTokens(req.user.id);
    if (!tokens) {
      return res.status(401).json({ error: 'QuickBooks not connected for this account' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    const response = await axios.get(
      `${baseUrl}/v3/company/${tokens.realm_id}/query?query=select * from Estimate ORDER BY TxnDate DESC MAXRESULTS 20`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json'
        }
      }
    );
    
    res.json({
      success: true,
      estimates: response.data.QueryResponse?.Estimate || []
    });
    
  } catch (error) {
    console.error('Get estimates error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to get estimates',
      details: error.response?.data || error.message
    });
  }
});

// Get invoices - for authenticated user's QuickBooks
router.get('/invoices', authenticateUser, async (req, res) => {
  try {
    const tokens = await getValidUserTokens(req.user.id);
    if (!tokens) {
      return res.status(401).json({ error: 'QuickBooks not connected for this account' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    const response = await axios.get(
      `${baseUrl}/v3/company/${tokens.realm_id}/query?query=select * from Invoice ORDER BY TxnDate DESC MAXRESULTS 20`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json'
        }
      }
    );
    
    res.json({
      success: true,
      invoices: response.data.QueryResponse?.Invoice || []
    });
    
  } catch (error) {
    console.error('Get invoices error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to get invoices',
      details: error.response?.data || error.message
    });
  }
});

module.exports = router;