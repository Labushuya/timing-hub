/**
 * seed.ts — development seed data
 *
 * Creates:
 *  - 1 admin user (admin@timinghub.de / dev_password)
 *  - 1 Veranstalter registration token (for local testing)
 *
 * Usage:
 *   pnpm --filter @timing-hub/api seed
 */
import postgres from 'postgres';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function seed() {
  console.log('[seed] Starting development seed...');

  // 1. Admin user
  const passwordHash = await argon2.hash('dev_password');
  const adminEmail = 'admin@timinghub.de';

  const [existing] = await sql`
    SELECT id FROM users WHERE email = ${adminEmail} LIMIT 1
  `;

  let adminId: string;
  if (existing) {
    adminId = existing.id as string;
    await sql`
      UPDATE users
      SET password_hash = ${passwordHash}, role = 'admin', updated_at = NOW()
      WHERE id = ${adminId}
    `;
    console.log(`[seed] Updated existing admin user: ${adminEmail}`);
  } else {
    const [created] = await sql`
      INSERT INTO users (email, password_hash, role, name)
      VALUES (${adminEmail}, ${passwordHash}, 'admin', 'Dev Admin')
      RETURNING id
    `;
    adminId = created!.id as string;
    console.log(`[seed] Created admin user: ${adminEmail} (id: ${adminId})`);
  }

  // 2. Registration token for Veranstalter testing
  const token = randomBytes(24).toString('hex');

  await sql`
    INSERT INTO registration_tokens (token, created_by, expires_at, note)
    VALUES (
      ${token},
      ${adminId},
      NOW() + INTERVAL '30 days',
      'dev seed token — local testing only'
    )
    ON CONFLICT DO NOTHING
  `;

  console.log('[seed] Done.');
  console.log('');
  console.log('  Admin login:');
  console.log(`    Email:    ${adminEmail}`);
  console.log('    Password: dev_password');
  console.log('');
  console.log('  Veranstalter registration token:');
  console.log(`    Token: ${token}`);
  console.log('');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exit(1);
  })
  .finally(() => sql.end());
