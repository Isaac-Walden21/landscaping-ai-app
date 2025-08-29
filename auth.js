const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./database');

// Register new contractor/user
router.post('/register', async (req, res) => {
  try {
    const { email, password, businessName, ownerName, phone } = req.body;
    
    // Validate input
    if (!email || !password || !businessName) {
      return res.status(400).json({ 
        error: 'Email, password, and business name are required' 
      });
    }
    
    // Check if user already exists
    const existingUser = await db.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ 
        error: 'An account with this email already exists' 
      });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create user
    const user = await db.createUser(email, passwordHash, businessName);
    
    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await db.createSession(user.id, sessionToken);
    
    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        businessName: user.business_name
      },
      sessionToken: sessionToken,
      message: 'Account created successfully. Please connect your QuickBooks account.'
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      error: 'Failed to create account',
      details: error.message 
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Email and password are required' 
      });
    }
    
    // Get user
    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ 
        error: 'Invalid email or password' 
      });
    }
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ 
        error: 'Invalid email or password' 
      });
    }
    
    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await db.createSession(user.id, sessionToken);
    
    // Check if QuickBooks is connected
    const qbTokens = await db.getUserTokens(user.id);
    const qbConnected = !!qbTokens;
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        businessName: user.business_name,
        ownerName: user.owner_name,
        phone: user.phone
      },
      sessionToken: sessionToken,
      quickbooksConnected: qbConnected
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Login failed',
      details: error.message 
    });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader?.replace('Bearer ', '');
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const user = await db.getUserBySessionToken(sessionToken);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    // Check QuickBooks connection
    const qbTokens = await db.getUserTokens(user.id);
    const qbConnected = !!qbTokens;
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        businessName: user.business_name,
        ownerName: user.owner_name,
        phone: user.phone,
        address: user.address,
        city: user.city,
        state: user.state,
        zip: user.zip
      },
      quickbooksConnected: qbConnected
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      error: 'Failed to get user info',
      details: error.message 
    });
  }
});

// Update user profile
router.put('/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader?.replace('Bearer ', '');
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const user = await db.getUserBySessionToken(sessionToken);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    const { businessName, ownerName, phone, address, city, state, zip } = req.body;
    
    const updateQuery = `
      UPDATE users 
      SET business_name = $1, owner_name = $2, phone = $3, 
          address = $4, city = $5, state = $6, zip = $7,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING id, email, business_name, owner_name, phone, address, city, state, zip
    `;
    
    const result = await db.pool.query(updateQuery, [
      businessName || user.business_name,
      ownerName || user.owner_name,
      phone || user.phone,
      address || user.address,
      city || user.city,
      state || user.state,
      zip || user.zip,
      user.id
    ]);
    
    res.json({
      success: true,
      user: result.rows[0]
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      error: 'Failed to update profile',
      details: error.message 
    });
  }
});

// Logout (invalidate session)
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader?.replace('Bearer ', '');
    
    if (sessionToken) {
      await db.pool.query(
        'DELETE FROM sessions WHERE token = $1',
        [sessionToken]
      );
    }
    
    res.json({ success: true, message: 'Logged out successfully' });
    
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ 
      error: 'Logout failed',
      details: error.message 
    });
  }
});

module.exports = router;