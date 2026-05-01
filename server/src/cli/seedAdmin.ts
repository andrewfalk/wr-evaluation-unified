#!/usr/bin/env node
/**
 * Seed an initial admin account into an empty database.
 *
 * Usage:
 *   npm run server:seed:admin
 *
 * Prompts for organization, login_id, and password via stdin so credentials
 * are never stored in shell history. Sets must_change_password=true so the
 * admin is forced to set a new password on first login.
 *
 * Safe to run on an existing DB: aborts if a user with the given login_id
 * already exists.
 */

import readline from 'readline';
import bcrypt from 'bcrypt';
import pg from 'pg';

const BCRYPT_ROUNDS = 12;

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Read a password from stdin without echoing characters.
// Falls back to visible input on non-TTY streams (e.g., piped CI input).
async function promptPassword(_rl: readline.Interface, question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive: read a single line from the already-open readline
    return new Promise((resolve) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        const nl  = str.indexOf('\n');
        if (nl !== -1) {
          buf += str.slice(0, nl).replace('\r', '');
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          resolve(buf);
        } else {
          buf += str;
        }
      };
      process.stdin.resume();
      process.stdin.on('data', onData);
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars: string[] = [];

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        const c = String.fromCharCode(byte);
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(chars.join(''));
        } else if (byte === 0x7f || byte === 0x08) {
          // Backspace / DEL
          chars.pop();
        } else if (byte === 0x03) {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(0);
        } else {
          chars.push(c);
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('=== wr-evaluation-unified: Admin seed ===');
    console.log('This creates the first admin account in an empty database.');
    console.log('');

    const organizationName = (await prompt(rl, 'Initial hospital/organization name: ')).trim();
    if (!organizationName) {
      console.error('ERROR: Organization name cannot be empty.');
      process.exit(1);
    }

    const loginId  = (await prompt(rl, 'Login ID (e.g. admin): ')).trim();
    if (!loginId) {
      console.error('ERROR: Login ID cannot be empty.');
      process.exit(1);
    }

    const password = (await promptPassword(rl, 'Password: ')).trim();
    if (password.length < 10) {
      console.error('ERROR: Password must be at least 10 characters.');
      process.exit(1);
    }

    const name = (await prompt(rl, 'Display name (e.g. 시스템 관리자): ')).trim() || '시스템 관리자';

    rl.close();

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      await client.query('BEGIN');

      // Abort if the login_id already exists
      const existing = await client.query(
        `SELECT id FROM users WHERE login_id = $1`,
        [loginId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        console.error(`ERROR: User with login_id "${loginId}" already exists.`);
        process.exitCode = 1;
        return;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const { rows: orgRows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (name)
         VALUES ($1)
         RETURNING id`,
        [organizationName]
      );
      const organizationId = orgRows[0].id;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
         VALUES ($1, $2, $3, 'admin', $4, true)
         RETURNING id`,
        [loginId, passwordHash, name, organizationId]
      );

      await client.query('COMMIT');

      console.log('');
      console.log(`\x1b[32mAdmin account created successfully.\x1b[0m`);
      console.log(`  ID:       ${rows[0].id}`);
      console.log(`  Login ID: ${loginId}`);
      console.log(`  Name:     ${name}`);
      console.log(`  Role:     admin`);
      console.log(`  Organization: ${organizationName} (${organizationId})`);
      console.log(`  must_change_password: true`);
      console.log('');
      console.log('Log in and change the password immediately.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
  } catch (err) {
    rl.close();
    console.error('ERROR:', err);
    process.exit(1);
  }
}

main();
