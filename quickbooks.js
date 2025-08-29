const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('./database');

// QuickBooks OAuth URLs
const SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_URL = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Store the current realm ID - will be loaded from database on startup
let currentRealmId = null;

// Load the most recent realm ID on startup
async function loadCurrentRealm() {
  try {
    const result = await db.pool.query(
      'SELECT realm_id FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1'
    );
    if (result.rows.length > 0) {
      currentRealmId = result.rows[0].realm_id;
      console.log('Loaded realm ID from database:', currentRealmId);
    }
  } catch (error) {
    console.error('Error loading realm ID:', error);
  }
}

// Call this on module load
loadCurrentRealm();

// Helper function to get valid tokens (refreshes if needed)
async function getValidTokens() {
  if (!currentRealmId) {
    return null;
  }
  
  const tokens = await db.getTokens(currentRealmId);
  if (!tokens) {
    return null;
  }
  
  // Check if token is expired or about to expire (within 5 minutes)
  const expiryTime = new Date(tokens.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60000);
  
  if (expiryTime < fiveMinutesFromNow) {
    console.log('Token expired or expiring soon, refreshing...');
    
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
      
      // Save new tokens
      await db.saveTokens(currentRealmId, access_token, refresh_token, expires_in);
      
      // Return the new tokens
      return await db.getTokens(currentRealmId);
    } catch (error) {
      console.error('Failed to refresh token:', error);
      return null;
    }
  }
  
  return tokens;
}

router.get('/status', async (req, res) => {
  try {
    // Check if we have tokens in database
    const tokens = await getValidTokens();
    const isConnected = tokens !== null;
    
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
      <p>Connection will persist across server restarts.</p>
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

// Test QuickBooks API connection
router.get('/company-info', async (req, res) => {
  try {
    const tokens = await getValidTokens();
    if (!tokens) {
      return res.status(401).json({ error: 'Not connected to QuickBooks or token expired' });
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

// Create or update customer in QuickBooks
router.post('/create-customer', async (req, res) => {
  try {
    const { customer_info } = req.body;
    
    const tokens = await getValidTokens();
    if (!tokens) {
      return res.status(401).json({ error: 'Not connected to QuickBooks or token expired' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    // Check if customer exists by email
    let customerId = null;
    if (customer_info.email) {
      try {
        const searchResponse = await axios.get(
          `${baseUrl}/v3/company/${currentRealmId}/query?query=select * from Customer where PrimaryEmailAddr='${customer_info.email}'`,
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
        console.log('Customer search error (likely not found):', searchError.message);
      }
    }
    
    let customer;
    if (customerId) {
      // Update existing customer
      const updateResponse = await axios.post(
        `${baseUrl}/v3/company/${currentRealmId}/customer`,
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
        `${baseUrl}/v3/company/${currentRealmId}/customer`,
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

// Create estimate in QuickBooks
router.post('/create-estimate', async (req, res) => {
  try {
    const { customerId, estimate_data } = req.body;
    
    const tokens = await getValidTokens();
    if (!tokens) {
      return res.status(401).json({ error: 'Not connected to QuickBooks or token expired' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    // Build line items from estimate
    const lineItems = [];
    
    // Add service items
    if (estimate_data.serviceItems && estimate_data.serviceItems.length > 0) {
      estimate_data.serviceItems.forEach(item => {
        lineItems.push({
          DetailType: 'SalesItemLineDetail',
          Amount: item.subtotal,
          Description: `${item.description} - ${item.quantity} ${item.unit} @ $${item.rate}/${item.unit}`,
          SalesItemLineDetail: {
            ItemRef: {
              value: '1', // You'll need to create/map actual QB items
              name: 'Services'
            }
          }
        });
      });
    }
    
    // Add material items
    if (estimate_data.materialItems && estimate_data.materialItems.length > 0) {
      estimate_data.materialItems.forEach(item => {
        lineItems.push({
          DetailType: 'SalesItemLineDetail',
          Amount: item.subtotal,
          Description: `${item.description} - ${item.quantity} ${item.unit}`,
          SalesItemLineDetail: {
            ItemRef: {
              value: '2', // You'll need to create/map actual QB items
              name: 'Materials'
            }
          }
        });
      });
    }
    
    // Ensure we have at least one line item
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
      ExpirationDate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0], // 30 days
      CustomerMemo: {
        value: estimate_data.projectInfo?.summary || 'Landscaping Estimate'
      }
    };
    
    const response = await axios.post(
      `${baseUrl}/v3/company/${currentRealmId}/estimate`,
      estimatePayload,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Save to local database
    if (estimate_data.customer_name || estimate_data.customer_email) {
      await db.pool.query(
        `INSERT INTO estimates (customer_name, customer_email, estimate_data, quickbooks_estimate_id)
         VALUES ($1, $2, $3, $4)`,
        [
          estimate_data.customer_name || 'Unknown',
          estimate_data.customer_email || '',
          JSON.stringify(estimate_data),
          response.data.Estimate.Id
        ]
      );
    }
    
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

// Get estimates from QuickBooks
router.get('/estimates', async (req, res) => {
  try {
    const tokens = await getValidTokens();
    if (!tokens) {
      return res.status(401).json({ error: 'Not connected to QuickBooks or token expired' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    const response = await axios.get(
      `${baseUrl}/v3/company/${currentRealmId}/query?query=select * from Estimate ORDER BY TxnDate DESC MAXRESULTS 20`,
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

// Get invoices from QuickBooks
router.get('/invoices', async (req, res) => {
  try {
    const tokens = await getValidTokens();
    if (!tokens) {
      return res.status(401).json({ error: 'Not connected to QuickBooks or token expired' });
    }
    
    const baseUrl = process.env.QB_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    
    const response = await axios.get(
      `${baseUrl}/v3/company/${currentRealmId}/query?query=select * from Invoice ORDER BY TxnDate DESC MAXRESULTS 20`,
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