const { Pool } = require('pg');

// Parse Railway's DATABASE_URL properly
let poolConfig = {};

if (process.env.DATABASE_URL) {
  // Railway provides a connection string that needs to be parsed
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  };
} else {
  // Fallback for local development
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

// Create tables if they don't exist
async function initializeDatabase() {
  try {
    // QuickBooks tokens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quickbooks_tokens (
        id SERIAL PRIMARY KEY,
        realm_id VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Estimates table (optional - to track what you've sent to QB)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        estimate_data JSONB,
        quickbooks_estimate_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Token management functions
async function saveTokens(realmId, accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  const query = `
    INSERT INTO quickbooks_tokens (realm_id, access_token, refresh_token, expires_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (realm_id) 
    DO UPDATE SET 
      access_token = $2,
      refresh_token = $3,
      expires_at = $4,
      updated_at = CURRENT_TIMESTAMP
  `;
  
  try {
    await pool.query(query, [realmId, accessToken, refreshToken, expiresAt]);
    console.log('Tokens saved successfully');
  } catch (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

async function getTokens(realmId) {
  try {
    const result = await pool.query(
      'SELECT * FROM quickbooks_tokens WHERE realm_id = $1',
      [realmId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Error getting tokens:', error);
    return null;
  }
}

module.exports = {
  pool,
  initializeDatabase,
  saveTokens,
  getTokens
};