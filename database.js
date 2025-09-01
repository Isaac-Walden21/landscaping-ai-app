// database.js - Complete multi-tenant database module for QuickBooks integration
const { Pool } = require('pg');
const crypto = require('crypto');

// Parse Railway's DATABASE_URL properly
let poolConfig = {};

if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  };
} else {
  poolConfig = {
    host: 'localhost',
    port: 5432,
    database: 'landscaping',
    user: 'postgres',
    password: 'postgres'
  };
}

const pool = new Pool(poolConfig);

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('Database connected successfully');
    release();
  }
});

// Initialize all required tables
async function initializeDatabase() {
  try {
    // Users table - your contractors
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        business_name VARCHAR(255),
        owner_name VARCHAR(255),
        phone VARCHAR(50),
        address VARCHAR(255),
        city VARCHAR(100),
        state VARCHAR(50),
        zip VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // QuickBooks tokens table - one per user
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quickbooks_tokens (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,  -- Changed to VARCHAR to support Supabase UUIDs
        realm_id VARCHAR(255) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)  -- One QuickBooks connection per user
      )
    `);

    // Create indexes for performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quickbooks_tokens_user_id 
      ON quickbooks_tokens(user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quickbooks_tokens_realm_id 
      ON quickbooks_tokens(realm_id)
    `);

    // Estimates table - linked to users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        estimate_data JSONB,
        quickbooks_estimate_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Invoices table - for tracking synced invoices
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        invoice_data JSONB,
        quickbooks_invoice_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Customers table - for tracking QB customer IDs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quickbooks_customers (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        local_customer_id VARCHAR(255),
        quickbooks_customer_id VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, local_customer_id)
      )
    `);

    // Payments table - for tracking payments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quickbooks_payments (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        invoice_id VARCHAR(255) NOT NULL,
        payment_id VARCHAR(255) NOT NULL,
        amount DECIMAL(10, 2),
        payment_date TIMESTAMP,
        payment_method VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sessions table for authentication (if not using Supabase)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Multi-tenant database tables initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

// ============= User Management Functions =============

async function createUser(email, passwordHash, businessName) {
  const query = `
    INSERT INTO users (email, password_hash, business_name)
    VALUES ($1, $2, $3)
    RETURNING id, email, business_name
  `;
  
  try {
    const result = await pool.query(query, [email, passwordHash, businessName]);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating user:', error);
    throw error;
  }
}

async function getUserByEmail(email) {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user by email:', error);
    return null;
  }
}

async function getUserById(userId) {
  try {
    const result = await pool.query(
      'SELECT id, email, business_name, owner_name, phone, address, city, state, zip FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user by ID:', error);
    return null;
  }
}

// ============= QuickBooks Token Management =============

async function saveUserTokens(userId, realmId, accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  const query = `
    INSERT INTO quickbooks_tokens (user_id, realm_id, access_token, refresh_token, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      realm_id = $2,
      access_token = $3,
      refresh_token = $4,
      expires_at = $5,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, realmId, accessToken, refreshToken, expiresAt]);
    console.log('Tokens saved for user:', userId);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

async function getUserTokens(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_tokens WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting user tokens:', error);
    return null;
  }
}

async function deleteUserTokens(userId) {
  try {
    await pool.query(
      'DELETE FROM quickbooks_tokens WHERE user_id = $1',
      [userId]
    );
    console.log('Tokens deleted for user:', userId);
    return true;
  } catch (error) {
    console.error('Error deleting tokens:', error);
    return false;
  }
}

// ============= Session Management =============

async function createSession(userId, token, expiresIn = 86400) { // 24 hours default
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  const query = `
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, token, expiresAt]);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating session:', error);
    throw error;
  }
}

async function getUserBySessionToken(token) {
  const query = `
    SELECT u.* FROM users u
    JOIN sessions s ON u.id::text = s.user_id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `;
  
  try {
    const result = await pool.query(query, [token]);
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user by session token:', error);
    return null;
  }
}

async function deleteExpiredSessions() {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch (error) {
    console.error('Error deleting expired sessions:', error);
  }
}

// ============= QuickBooks Customer Management =============

async function saveQuickBooksCustomer(userId, localCustomerId, qbCustomerId, customerName, customerEmail) {
  const query = `
    INSERT INTO quickbooks_customers (user_id, local_customer_id, quickbooks_customer_id, customer_name, customer_email)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, local_customer_id)
    DO UPDATE SET
      quickbooks_customer_id = $3,
      customer_name = $4,
      customer_email = $5,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, localCustomerId, qbCustomerId, customerName, customerEmail]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving QuickBooks customer:', error);
    throw error;
  }
}

async function getQuickBooksCustomer(userId, localCustomerId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_customers WHERE user_id = $1 AND local_customer_id = $2',
      [userId, localCustomerId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error getting QuickBooks customer:', error);
    return null;
  }
}

// ============= Invoice Management =============

async function saveInvoice(userId, customerName, customerEmail, invoiceData, qbInvoiceId) {
  const query = `
    INSERT INTO invoices (user_id, customer_name, customer_email, invoice_data, quickbooks_invoice_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, customerName, customerEmail, invoiceData, qbInvoiceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving invoice:', error);
    throw error;
  }
}

async function getUserInvoices(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting user invoices:', error);
    return [];
  }
}

// ============= Estimate Management =============

async function saveEstimate(userId, customerName, customerEmail, estimateData, qbEstimateId) {
  const query = `
    INSERT INTO estimates (user_id, customer_name, customer_email, estimate_data, quickbooks_estimate_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, customerName, customerEmail, estimateData, qbEstimateId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving estimate:', error);
    throw error;
  }
}

async function getUserEstimates(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM estimates WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting user estimates:', error);
    return [];
  }
}

// ============= Payment Management =============

async function savePayment(userId, invoiceId, paymentId, amount, paymentDate, paymentMethod) {
  const query = `
    INSERT INTO quickbooks_payments (user_id, invoice_id, payment_id, amount, payment_date, payment_method)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [userId, invoiceId, paymentId, amount, paymentDate, paymentMethod]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving payment:', error);
    throw error;
  }
}

async function getUserPayments(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_payments WHERE user_id = $1 ORDER BY payment_date DESC',
      [userId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting user payments:', error);
    return [];
  }
}

// ============= Legacy Support Functions =============
// These maintain backwards compatibility with your existing code

async function getTokens(realmId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_tokens WHERE realm_id = $1 LIMIT 1',
      [realmId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting tokens by realm:', error);
    return null;
  }
}

async function saveTokens(realmId, accessToken, refreshToken, expiresIn) {
  // For legacy support, use a default user ID
  const defaultUserId = 'legacy-single-user';
  return await saveUserTokens(defaultUserId, realmId, accessToken, refreshToken, expiresIn);
}

// ============= Utility Functions =============

async function cleanupOldData() {
  try {
    // Delete expired sessions
    await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    
    // Delete old tokens that expired more than 30 days ago
    await pool.query(
      "DELETE FROM quickbooks_tokens WHERE expires_at < NOW() - INTERVAL '30 days'"
    );
    
    console.log('Old data cleaned up');
  } catch (error) {
    console.error('Error cleaning up old data:', error);
  }
}

// Run cleanup every 24 hours
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

// Initialize database on module load
initializeDatabase().catch(console.error);

// Export all functions
module.exports = {
  pool,
  initializeDatabase,
  
  // User management
  createUser,
  getUserByEmail,
  getUserById,
  
  // Token management
  saveUserTokens,
  getUserTokens,
  deleteUserTokens,
  
  // Session management
  createSession,
  getUserBySessionToken,
  deleteExpiredSessions,
  
  // QuickBooks customer management
  saveQuickBooksCustomer,
  getQuickBooksCustomer,
  
  // Invoice management
  saveInvoice,
  getUserInvoices,
  
  // Estimate management
  saveEstimate,
  getUserEstimates,
  
  // Payment management
  savePayment,
  getUserPayments,
  
  // Legacy support
  getTokens,
  saveTokens,
  
  // Utility
  cleanupOldData
};