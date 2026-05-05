import { createHash, randomBytes } from 'crypto';
import pg from 'pg';
import { config } from 'dotenv';

config({ path: '.env' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const apiKey = randomBytes(32).toString('hex');
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const id = crypto.randomUUID();

await client.query(
  `INSERT INTO tenants (id, name, slug, api_key_hash, settings, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
   ON CONFLICT DO NOTHING`,
  [id, 'Default Tenant', 'default', apiKeyHash, '{}'],
);

await client.end();

console.log('\n✅ Tenant created\n');
console.log('Tenant ID :', id);
console.log('API Key   :', apiKey);
console.log('\nUse this header in requests:');
console.log(`  Authorization: Bearer ${apiKey}\n`);
