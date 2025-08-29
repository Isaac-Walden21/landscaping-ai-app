const { Pool } = require('pg');

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

// Create tables for multi-tenant architecture
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
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        realm_id VARCHAR(255) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, realm_id)
      )
    `);

    // Create index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quickbooks_tokens_user_id 
      ON quickbooks_tokens(user_id)
    `);

    // Estimates table - linked to users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        estimate_data JSONB,
        quickbooks_estimate_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sessions table for authentication
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Multi-tenant database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// User management functions
async function createUser(email, passwordHash, businessName) {
  const query = `
    INSERT INTO users (email, password_hash, business_name)
    VALUES ($1, $2, $3)
    RETURNING id, email, business_name
  `;
  
  const result = await pool.query(query, [email, passwordHash, businessName]);
  return result.rows[0];
}

async function getUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0];
}

async function getUserById(userId) {
  const result = await pool.query(
    'SELECT id, email, business_name, owner_name, phone, address, city, state, zip FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0];
}

// Token management functions - now per user
async function saveUserTokens(userId, realmId, accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  const query = `
    INSERT INTO quickbooks_tokens (user_id, realm_id, access_token, refresh_token, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, realm_id) 
    DO UPDATE SET 
      access_token = $3,
      refresh_token = $4,
      expires_at = $5,
      updated_at = CURRENT_TIMESTAMP
  `;
  
  try {
    await pool.query(query, [userId, realmId, accessToken, refreshToken, expiresAt]);
    console.log('Tokens saved for user:', userId);
  } catch (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

async function getUserTokens(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [userId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user tokens:', error);
    return null;
  }
}

// Session management
async function createSession(userId, token, expiresIn = 86400) { // 24 hours default
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  const query = `
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  
  const result = await pool.query(query, [userId, token, expiresAt]);
  return result.rows[0];
}

async function getUserBySessionToken(token) {
  const query = `
    SELECT u.* FROM users u
    JOIN sessions s ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `;
  
  const result = await pool.query(query, [token]);
  return result.rows[0];
}

module.exports = {
  pool,
  initializeDatabase,
  createUser,
  getUserByEmail,
  getUserById,
  saveUserTokens,
  getUserTokens,
  createSession,
  getUserBySessionToken
};