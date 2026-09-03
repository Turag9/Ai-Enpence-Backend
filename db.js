import dotenv from 'dotenv';
import pkg from 'pg';
import { lookup } from 'dns/promises';

dotenv.config();

const { Pool, types } = pkg;

// Return DATE columns (OID 1082) as plain 'YYYY-MM-DD' strings instead of JS Date,
// so JSON serialization doesn't UTC-shift the date for clients in non-UTC timezones.
types.setTypeParser(1082, (val) => val);

// Node v24 uses Happy Eyeballs v2 (RFC 8305) which prefers IPv6.
// Neon's IPv6 endpoints are unreachable on many networks, causing ETIMEDOUT.
// We pre-resolve the hostname to IPv4 and pass it directly to the pool.
const dbUrl = new URL(process.env.DATABASE_URL);
let resolvedHost;

try {
  const { address } = await lookup(dbUrl.hostname, { family: 4 });
  resolvedHost = address;
} catch {
  // Fall back to hostname if DNS lookup fails (e.g. offline dev)
  resolvedHost = dbUrl.hostname;
}

const pool = new Pool({
  host: resolvedHost,
  port: Number(dbUrl.port) || 5432,
  database: dbUrl.pathname.replace(/^\//, ''),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  ssl: {
    rejectUnauthorized: false,
    servername: dbUrl.hostname, // SNI — required for Neon routing
  },
  connectionTimeoutMillis: 10000,
  max: 10,
});

pool.on('connect', () => {
  console.log('Connected to Neon Postgres');
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

export default pool;
