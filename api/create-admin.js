// Run manually from Railway shell with ADMIN_EMAIL and ADMIN_PASSWORD set temporarily.
// Do not store passwords in GitHub or in persistent service variables.
import crypto from 'node:crypto';
import { Pool } from 'pg';
const email=process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password=process.env.ADMIN_PASSWORD;
const name=process.env.ADMIN_NAME?.trim() || 'Administrator';
if (!email || !email.includes('@') || !password || password.length < 16 || !process.env.DATABASE_URL) {
  throw new Error('Krever DATABASE_URL, ADMIN_EMAIL og ADMIN_PASSWORD (minst 16 tegn)');
}
const salt=crypto.randomBytes(16).toString('hex');
const hash='scrypt:'+salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
const db=new Pool({connectionString:process.env.DATABASE_URL});
try {
  const r=await db.query(`INSERT INTO portal_users(email,password_hash,full_name,role)
    VALUES($1,$2,$3,'admin') ON CONFLICT(email) DO NOTHING RETURNING id`,[email,hash,name]);
  console.log(r.rowCount?'Administrator opprettet':'Bruker finnes allerede. Ingen endringer.');
} finally { await db.end(); }
