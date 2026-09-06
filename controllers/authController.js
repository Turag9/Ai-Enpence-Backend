import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { defaultCategories } from '../utils/defaultCategories.js';
import { sendOtpEmail } from '../utils/mailer.js';

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

export const register = async (req, res) => {
  const { name, email, password, currency = 'USD' } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    await client.query('BEGIN');

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash, currency)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, currency, created_at`,
      [name, email, passwordHash, currency]
    );

    const user = userResult.rows[0];

    for (const cat of defaultCategories) {
      await client.query(
        `INSERT INTO categories (user_id, name, type, icon, color, is_default)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [user.id, cat.name, cat.type, cat.icon, cat.color]
      );
    }

    await client.query('COMMIT');

    const token = signToken(user.id);
    res.status(201).json({ user, token });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};
export const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, name, email, password_hash, currency FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = signToken(user.id);
    res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      currency: user.currency,
    },
    token,
  });
} catch (error) {
  console.error('Login error:', error);
  res.status(500).json({ message: 'Server error' });
}
};
export const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, currency, created_at FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('GetMe error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── Forgot Password: generate OTP and send email ────────────────────────────
export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // security: don't reveal if email exists
      return res.json({ message: 'If that email exists, an OTP has been sent.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in DB (upsert by email)
    await pool.query(
      `INSERT INTO password_reset_tokens (email, otp, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET otp = $2, expires_at = $3, used = false`,
      [email, otp, expiresAt]
    );

    await sendOtpEmail(email, otp);
    res.json({ message: 'If that email exists, an OTP has been sent.' });
  } catch (error) {
    console.error('ForgotPassword error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── Verify OTP ───────────────────────────────────────────────────────────────
export const verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  try {
    const result = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    const record = result.rows[0];
    if (record.used) return res.status(400).json({ message: 'OTP already used' });
    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ message: 'OTP expired' });
    }
    if (record.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    res.json({ message: 'OTP verified', valid: true });
  } catch (error) {
    console.error('VerifyOtp error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── Reset Password ───────────────────────────────────────────────────────────
export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Email, OTP and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM password_reset_tokens WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const record = result.rows[0];
    if (record.used) return res.status(400).json({ message: 'OTP already used' });
    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ message: 'OTP expired' });
    }
    if (record.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, email]);
    await client.query('UPDATE password_reset_tokens SET used = true WHERE email = $1', [email]);
    await client.query('COMMIT');

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ResetPassword error:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};