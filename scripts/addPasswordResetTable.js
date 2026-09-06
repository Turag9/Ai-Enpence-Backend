// Run this once: node scripts/addPasswordResetTable.js
import pool from '../db.js';

const sql = `
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) UNIQUE NOT NULL,
    otp        VARCHAR(6)  NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN     DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

try {
  await pool.query(sql);
  console.log('✅  password_reset_tokens table created (or already exists).');
} catch (err) {
  console.error('❌  Error creating table:', err.message);
} finally {
  await pool.end();
}
