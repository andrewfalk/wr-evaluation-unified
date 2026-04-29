#!/usr/bin/env node
/**
 * Seed an initial admin account into an empty database.
 *
 * Usage:
 *   npm run server:seed:admin
 *
 * Prompts for login_id and password via stdin so the credentials are never
 * stored in shell history. Sets must_change_password=true so the admin is
 * forced to set a new password on first login.
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

async function promptPassword(rl: readline.Interface, question: string): Promise<string> {
  // On a real TTY we would suppress echo; Node's readline has no built-in for
  // this without native deps. We use a convention: warn the user and move on.
  process.stdout.write('\x1b[33mWARNING: password will be visible while typing.\x1b[0m\n');
  return prompt(rl, question);
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
      // Abort if the login_id already exists
      const existing = await client.query(
        `SELECT id FROM users WHERE login_id = $1`,
        [loginId]
      );
      if (existing.rows.length > 0) {
        console.error(`ERROR: User with login_id "${loginId}" already exists.`);
        process.exit(1);
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (login_id, password_hash, name, role, must_change_password)
         VALUES ($1, $2, $3, 'admin', true)
         RETURNING id`,
        [loginId, passwordHash, name]
      );

      console.log('');
      console.log(`\x1b[32mAdmin account created successfully.\x1b[0m`);
      console.log(`  ID:       ${rows[0].id}`);
      console.log(`  Login ID: ${loginId}`);
      console.log(`  Name:     ${name}`);
      console.log(`  Role:     admin`);
      console.log(`  must_change_password: true`);
      console.log('');
      console.log('Log in and change the password immediately.');
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
