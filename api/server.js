import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';


const imageBucket=process.env.S3_BUCKET;
const imageClient=imageBucket && process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
  ? new S3Client({region:process.env.S3_REGION||'auto',endpoint:process.env.S3_ENDPOINT,forcePathStyle:false,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}})
  : null;
const imagePath=(reportId,key)=>'/api/reports/'+reportId+'/images/'+key;
const imageKey=(report,kind)=>'projects/'+reportLabel(report).report_code+'/'+reportLabel(report).report_code+'-'+kind+'-'+crypto.randomUUID().slice(0,8)+'.jpg';
async function storeImage(report,bytes,kind='funn01'){
  if(!imageClient)throw fail(503,'Bildelagring er ikke konfigurert');
  if(bytes.length<1||bytes.length>8*1024*1024)throw fail(413,'Bildet er for stort (maks 8 MB)');
  const key=imageKey(report,kind);
  await imageClient.send(new PutObjectCommand({Bucket:imageBucket,Key:key,Body:bytes,ContentType:'image/jpeg',CacheControl:'private, max-age=3600'}));
  return imagePath(report.id,key.slice(key.lastIndexOf('/')+1,-4));
}
async function moveEmbeddedImages(reportId,content){
  const walk=async value=>{
    if(typeof value==='string'&&value.startsWith('data:image/')){
      const match=/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if(!match)throw fail(400,'Ugyldig bildeformat');
      if(!imageClient)throw fail(503,'Bildelagring er ikke konfigurert');
      const bytes=Buffer.from(match[2],'base64');
      if(bytes.length>8*1024*1024)throw fail(413,'Bildet er for stort');
      const type=match[1]==='jpg'?'jpeg':match[1];
      const key='reports/'+reportId+'/'+crypto.randomUUID()+'.'+(type==='jpeg'?'jpg':type);
      await imageClient.send(new PutObjectCommand({Bucket:imageBucket,Key:key,Body:bytes,ContentType:'image/'+type}));
      return imagePath(reportId,key.slice(('reports/'+reportId+'/').length).replace(/\.(jpg|png|webp)$/,''));
    }
    if(Array.isArray(value))return Promise.all(value.map(walk));
    if(value&&typeof value==='object'){
      const out={};
      for(const [key,v] of Object.entries(value))out[key]=await walk(v);
      return out;
    }
    return value;
  };
  return walk(content);
}

const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 8 }) : null;
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
};
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(v);
const text = (v, max=200) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
const reportPrefix = type => {
  const t=(type||'').toLowerCase();
  if(t.includes('modellering')||t.includes('modell'))return 'MOD';
  if(t.includes('termografi')||t.includes('termograf'))return 'TAK-TMO';
  if(t.includes('visuell')&&t.includes('tak'))return 'TAK-VIS';
  if(t.includes('solcelle'))return 'SOL';
  if(t.includes('energi'))return 'ENG';
  if(t.includes('oppmåling')||t.includes('3d'))return 'OPPM';
  if(t.includes('tak'))return 'TAK-VIS';
  return 'RAP';
};
const reportLabel = r => r && ({...r,report_code:reportPrefix(r.report_type)+'-'+String(r.report_number).padStart(4,'0')+'-'+new Date(r.created_at).toLocaleDateString('en-GB',{month:'2-digit',year:'2-digit',timeZone:'Europe/Oslo'}).replace('/','')});
const customerLabel = c => c && ({...c,customer_code:'K-'+String(c.customer_number).padStart(4,'0')});
const passwordHash = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
};
const checkPassword = (password, stored) => {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const [,salt,hash] = stored.split(':');
  if (!salt || !/^[0-9a-f]{128}$/.test(hash || '')) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password,salt,64),Buffer.from(hash,'hex'));
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s=>s.trim().split('=')).filter(p=>p.length===2));
const cookie = (res, value, age) => res.setHeader('Set-Cookie','pba_session='+value+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='+age);
const origin = process.env.APP_ORIGIN || '';
const guardOrigin = req => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return;
  const actual = req.headers.origin;
  if (!origin || actual !== origin) throw fail(403,'Ugyldig opprinnelse');
};
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415,'Krever JSON');
  const maxBytes = req.method === 'PATCH' && /^\/api\/reports\/[0-9a-f-]{36}$/i.test(new URL(req.url,'http://localhost').pathname) ? 24 * 1024 * 1024 : 1024 * 1024;
  let size=0;const parts=[];
  for await (const part of req) { size+=part.length; if(size>maxBytes)throw fail(413,'Rapporten inneholder for mange eller for store bilder. Maks 24 MB per lagring.');parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw fail(400,'Ugyldig JSON'); }
}
async function currentUser(req) {
  const token = cookies(req).pba_session;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) throw fail(401,'Ikke innlogget');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const {rows} = await pool.query(`SELECT u.id,u.email,u.full_name,u.role FROM portal_sessions s
    JOIN portal_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true`,[hash]);
  if (!rows[0]) throw fail(401,'Ikke innlogget');
  return rows[0];
}
const staff = u => { if (!['admin','employee'].includes(u.role)) throw fail(403,'Ingen tilgang'); };
const admin = u => { if (u.role !== 'admin') throw fail(403,'Kun administrator'); };
async function customerAccess(user, customerId) {
  if (user.role !== 'customer') return;
  const r=await pool.query('SELECT 1 FROM customer_memberships WHERE user_id=$1 AND customer_id=$2',[user.id,customerId]);
  if (!r.rowCount) throw fail(404,'Ikke funnet');
}
async function propertyAccess(user, propertyId) {
  const r=await pool.query('SELECT id,customer_id,name,address,postal_code,municipality,cadastral_reference FROM properties WHERE id=$1',[propertyId]);
  if (!r.rowCount) throw fail(404,'Eiendom ikke funnet');
  await customerAccess(user,r.rows[0].customer_id);
  return r.rows[0];
}
async function reportAccess(user, reportId) {
  const r=await pool.query(`SELECT r.*,p.customer_id FROM reports r JOIN properties p ON p.id=r.property_id WHERE r.id=$1`,[reportId]);
  if (!r.rowCount) throw fail(404,'Rapport ikke funnet');
  const report=r.rows[0];
  await customerAccess(user,report.customer_id);
  if (user.role==='customer' && report.status!=='published') throw fail(404,'Rapport ikke funnet');
  return report;
}
async function transaction(fn) {
  const c=await pool.connect();
  try { await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result; }
  catch(e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
async function init() {
  if (!pool) { console.warn('DATABASE_URL mangler. Kun /health tilgjengelig.'); return; }
  const sql=await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8');
  await pool.query(sql);
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // One-time administrator bootstrap. Remove ADMIN_PASSWORD from Railway immediately after success.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email=process.env.ADMIN_EMAIL.trim().toLowerCase();
    const password=process.env.ADMIN_PASSWORD;
    if (!email.includes('@') || password.length < 16) throw new Error('Ugyldig administratoroppsett');
    const result=await pool.query(
      "INSERT INTO portal_users(email,password_hash,full_name,role) VALUES($1,$2,$3,'admin') ON CONFLICT(email) DO NOTHING RETURNING id",
      [email,passwordHash(password),process.env.ADMIN_NAME?.trim() || 'Administrator']
    );
    console.log(result.rowCount ? 'Administrator opprettet' : 'Administratorkonto finnes allerede');
  }
  console.log('Databaseskjema kontrollert');
}
async function handler(req,res) {
  if (origin && req.headers.origin === origin) {
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Vary','Origin');
  }
  if (req.method === 'OPTIONS') {
    if (req.headers.origin !== origin) throw fail(403,'Ugyldig opprinnelse');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.writeHead(204); return res.end();
  }
  const url=new URL(req.url,'http://localhost');
  if (url.pathname==='/' && req.method==='GET') {
    const page=await fs.readFile(new URL('./portal.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if ((url.pathname==='/tilbud' || url.pathname==='/be-om-tilbud') && req.method==='GET') {
    const page=await fs.readFile(new URL('./quote-request.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if (url.pathname==='/tilbud/admin' && req.method==='GET') {
    const user=await currentUser(req);staff(user);
    const page=await fs.readFile(new URL('./quote-admin.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if (url.pathname==='/tilbud/svar' && req.method==='GET') {
    const page=await fs.readFile(new URL('./quote-accept.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if (url.pathname==='/report-preview' && req.method==='GET') {
    const user=await currentUser(req);staff(user);
    const reportId=url.searchParams.get('id');
    if (!id(reportId)) throw fail(400,'Ugyldig rapport-ID');
    await reportAccess(user,reportId);
    const page=await fs.readFile(new URL('./report-preview.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return res.end(page);
  }
  if(url.pathname==='/report-images' && req.method==='GET'){
    const user=await currentUser(req);staff(user);
    const reportId=url.searchParams.get('id');
    if(!id(reportId))throw fail(400,'Ugyldig rapport-ID');
    await reportAccess(user,reportId);
    const page=await fs.readFile(new URL('./report-images.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return res.end(page);
  }
  if (url.pathname==='/report-editor' && req.method==='GET') {
    if (!pool) throw fail(503,'Database ikke konfigurert');
    const user=await currentUser(req);staff(user);
    const reportId=url.searchParams.get('id');
    if (!id(reportId)) throw fail(400,'Ugyldig rapport-ID');
    const report=await reportAccess(user,reportId);
    if (report.status!=='draft') throw fail(409,'Rapporten er ikke redigerbar');
    const page=await fs.readFile(new URL('./report-editor.html',import.meta.url));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self' https://api.open-meteo.com https://archive-api.open-meteo.com https://geocoding-api.open-meteo.com blob: data:; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; connect-src 'self' https://api.open-meteo.com https://archive-api.open-meteo.com https://geocoding-api.open-meteo.com; img-src 'self' blob: data:; media-src 'self' blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if (url.pathname==='/health' && req.method==='GET') {
    if (!pool) return json(res,503,{status:'database_not_configured'});
    try { await pool.query('SELECT 1'); return json(res,200,{status:'ok'}); }
    catch { return json(res,503,{status:'database_unavailable'}); }
  }
  if (!pool) throw fail(503,'Database ikke konfigurert');
  if (!url.pathname.startsWith('/api/')) throw fail(404,'Ikke funnet');
  guardOrigin(req);
  const method=req.method;
  if (url.pathname==='/api/quote-requests' && method==='POST') {
    const b=await body(req);
    const allowed=['TAK-VIS','TAK-TMO','SOL','ENG','OPPM','MOD'];
    if(!['private','business'].includes(b.customer_type)||!text(b.customer_name)||!text(b.email,254)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)||!text(b.property_address,250)||!Array.isArray(b.services)||!b.services.length||b.services.length>allowed.length||new Set(b.services).size!==b.services.length||!b.services.every(v=>allowed.includes(v)))throw fail(400,'Kontroller obligatoriske opplysninger');
    const fields=['phone','organization_number','postal_code','municipality','gnr','bnr','building_type','property_notes'];
    const lengths=[30,30,10,100,20,20,100,4000];
    const extra=fields.map((key,i)=>b[key]===undefined||b[key]===''?null:text(b[key],lengths[i]));
    if(fields.some((key,i)=>b[key]!==undefined&&b[key]!==''&&!extra[i]))throw fail(400,'Et felt er for langt');
    const token=crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO quote_requests(public_token,customer_type,customer_name,email,property_address,services,phone,organization_number,postal_code,municipality,gnr,bnr,building_type,property_notes,price_display)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[token,b.customer_type,b.customer_name.trim(),b.email.trim(),b.property_address.trim(),JSON.stringify(b.services),...extra,b.customer_type==='private'?'incl':'excl']);
    return json(res,201,{ok:true});
  }
  const quotePublic=url.pathname.match(/^\/api\/quote\/([a-f0-9]{48})$/);
  const quoteRespond=url.pathname.match(/^\/api\/quote\/([a-f0-9]{48})\/respond$/);
  if(quotePublic && method==='GET'){
    const q=await pool.query("SELECT customer_name,property_address,services,line_items,discount_percent,price_display,offer_notes,valid_until,status,public_token FROM quote_requests WHERE public_token=$1 AND status IN ('sent','accepted','declined')",[quotePublic[1]]);
    if(!q.rowCount)throw fail(404,'Tilbud ikke funnet');
    return json(res,200,q.rows[0]);
  }
  if(quoteRespond && method==='POST'){
    const b=await body(req);if(!['accepted','declined'].includes(b.action))throw fail(400,'Ugyldig svar');
    const result=await transaction(async c=>{
      const q=await c.query("SELECT * FROM quote_requests WHERE public_token=$1 FOR UPDATE",[quoteRespond[1]]);
      const offer=q.rows[0];
      if(!offer||offer.status!=='sent')throw fail(409,'Tilbudet er ikke tilgjengelig for svar');
      if(offer.valid_until && new Date(String(offer.valid_until).slice(0,10)+'T23:59:59Z')<new Date())throw fail(409,'Tilbudet er utløpt');
      if(b.action==='declined'){await c.query("UPDATE quote_requests SET status='declined',updated_at=now() WHERE id=$1",[offer.id]);return {status:'declined'};}
      const cust=await c.query('INSERT INTO customers(name,organization_number) VALUES($1,$2) RETURNING id',[offer.customer_name,offer.organization_number]);
      const prop=await c.query('INSERT INTO properties(customer_id,name,address,postal_code,municipality,cadastral_reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[cust.rows[0].id,offer.property_address,offer.property_address,offer.postal_code,offer.municipality,[offer.gnr,offer.bnr].filter(Boolean).join('/')]);
      const report=await c.query(`INSERT INTO reports(property_id,created_by,title,report_type,content)
        VALUES($1,(SELECT id FROM portal_users WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1),$2,$3,$4) RETURNING id`,[prop.rows[0].id,'Inspeksjon – '+offer.property_address,offer.services.length===1?({'TAK-VIS':'Visuell takinspeksjon','TAK-TMO':'Takinspeksjon – termografi','SOL':'Solcelleinspeksjon','ENG':'Energiscreening','OPPM':'Oppmåling','MOD':'Modellering'}[offer.services[0]]):'Kombinert inspeksjonsrapport',JSON.stringify({fields:{company:offer.customer_name,address:offer.property_address,postalCode:offer.postal_code,city:offer.municipality},modules:offer.services.map(x=>({'TAK-VIS':0,'TAK-TMO':1,'ENG':3,'SOL':4,'OPPM':5}[x])).filter(x=>x!==undefined),quote:{id:offer.id,services:offer.services,gnr:offer.gnr,bnr:offer.bnr,building_type:offer.building_type,notes:offer.property_notes},findings:[],overview:[]})]);
      await c.query("UPDATE quote_requests SET status='accepted',accepted_at=now(),updated_at=now(),customer_id=$2,property_id=$3,report_id=$4 WHERE id=$1",[offer.id,cust.rows[0].id,prop.rows[0].id,report.rows[0].id]);
      return {status:'accepted'};
    });
    return json(res,200,result);
  }
  if (url.pathname==='/api/login' && method==='POST') {
    const b=await body(req);
    if (!text(b.email,254) || typeof b.password!=='string') throw fail(400,'Mangler e-post eller passord');
    const {rows}=await pool.query('SELECT * FROM portal_users WHERE lower(email)=lower($1) AND is_active=true',[b.email.trim()]);
    if (!rows[0] || !checkPassword(b.password,rows[0].password_hash)) throw fail(401,'Feil e-post eller passord');
    const token=crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO portal_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval \'7 days\')',
      [crypto.createHash('sha256').update(token).digest('hex'),rows[0].id]);
    cookie(res,token,604800);
    return json(res,200,{id:rows[0].id,email:rows[0].email,name:rows[0].full_name,role:rows[0].role});
  }
  const user=await currentUser(req);
  if (url.pathname==='/api/logout' && method==='POST') {
    const token=cookies(req).pba_session;
    await pool.query('DELETE FROM portal_sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]);
    cookie(res,'',0); return json(res,200,{ok:true});
  }
  if (url.pathname==='/api/me' && method==='GET') return json(res,200,user);
  if(url.pathname==='/api/quote-requests' && method==='GET'){
    staff(user);
    const q=await pool.query("SELECT id,customer_type,customer_name,email,phone,organization_number,property_address,postal_code,municipality,gnr,bnr,building_type,property_notes,services,status,line_items,discount_percent,price_display,offer_notes,valid_until,public_token,created_at,report_id FROM quote_requests ORDER BY created_at DESC LIMIT 200");
    return json(res,200,q.rows);
  }
  const quoteEdit=url.pathname.match(/^\/api\/quote-requests\/([0-9a-f-]{36})$/i);
  if(quoteEdit && method==='PATCH'){
    staff(user);const b=await body(req);
    if(!Array.isArray(b.line_items)||b.line_items.length>30||!b.line_items.every(x=>text(x.description,200)&&Number.isFinite(x.price)&&x.price>=0&&x.price<=10000000)||!Number.isFinite(b.discount_percent)||b.discount_percent<0||b.discount_percent>100||!['incl','excl'].includes(b.price_display)||!['priced','sent'].includes(b.status))throw fail(400,'Ugyldig tilbudspris');
    if(b.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(b.valid_until))throw fail(400,'Ugyldig gyldighetsdato');
    const q=await pool.query(`UPDATE quote_requests SET line_items=$2,discount_percent=$3,price_display=$4,offer_notes=$5,valid_until=$6,status=$7,sent_at=CASE WHEN $7='sent' THEN now() ELSE sent_at END,updated_at=now()
    WHERE id=$1 AND status IN ('new','priced','sent') RETURNING id,public_token,status`,[quoteEdit[1],JSON.stringify(b.line_items),b.discount_percent,b.price_display,text(b.offer_notes,4000),b.valid_until||null,b.status]);
    if(!q.rowCount)throw fail(409,'Tilbudet kan ikke endres');
    return json(res,200,{...q.rows[0],url:'/tilbud/svar?token='+q.rows[0].public_token});
  }
  if (url.pathname==='/api/customers' && method==='GET') {
    const q=user.role==='customer'
      ? await pool.query('SELECT c.id,c.name FROM customers c JOIN customer_memberships m ON m.customer_id=c.id WHERE m.user_id=$1 ORDER BY c.name',[user.id])
      : await pool.query('SELECT id,name,organization_number,customer_number FROM customers ORDER BY name');
    return json(res,200,q.rows.map(customerLabel));
  }
  if (url.pathname==='/api/customers' && method==='POST') {
    admin(user); const b=await body(req);
    if (!text(b.name)) throw fail(400,'Mangler kundenavn');
    const q=await pool.query('INSERT INTO customers(name,organization_number) VALUES ($1,$2) RETURNING *',[b.name.trim(),text(b.organization_number,30)]);
    return json(res,201,customerLabel(q.rows[0]));
  }
  if (url.pathname==='/api/properties' && method==='GET') {
    const customerId=url.searchParams.get('customer_id');
    if (customerId && !id(customerId)) throw fail(400,'Ugyldig kunde');
    if (customerId) await customerAccess(user,customerId);
    const q=await pool.query(`SELECT p.id,p.customer_id,p.name,p.address,p.postal_code,p.municipality,p.cadastral_reference
      FROM properties p WHERE ($1::uuid IS NULL OR p.customer_id=$1)
      AND ($2::text <> 'customer' OR EXISTS (SELECT 1 FROM customer_memberships m WHERE m.customer_id=p.customer_id AND m.user_id=$3))
      ORDER BY p.name`,[customerId,user.role,user.id]);
    return json(res,200,q.rows);
  }
  if (url.pathname==='/api/properties' && method==='POST') {
    staff(user); const b=await body(req);
    if (!id(b.customer_id)||!text(b.name)||!text(b.address)) throw fail(400,'Mangler eiendomsdata');
    const q=await pool.query(`INSERT INTO properties(customer_id,name,address,postal_code,municipality,cadastral_reference)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[b.customer_id,b.name.trim(),b.address.trim(),text(b.postal_code,10),text(b.municipality,100),text(b.cadastral_reference,100)]);
    return json(res,201,q.rows[0]);
  }
  if (url.pathname==='/api/reports' && method==='GET') {
    const propertyId=url.searchParams.get('property_id');
    if (!id(propertyId)) throw fail(400,'Velg eiendom');
    await propertyAccess(user,propertyId);
    const q=await pool.query(`SELECT id,property_id,title,report_type,status,created_at,updated_at,published_at FROM reports
      WHERE property_id=$1 AND ($2::text <> 'customer' OR status='published') ORDER BY created_at DESC`,[propertyId,user.role]);
    return json(res,200,q.rows.map(reportLabel));
  }
  if (url.pathname==='/api/reports' && method==='POST') {
    staff(user); const b=await body(req);
    if (!id(b.property_id)||!text(b.title,300)||!b.content||typeof b.content!=='object'||Array.isArray(b.content)) throw fail(400,'Ugyldig rapport');
    await propertyAccess(user,b.property_id);
    const q=await pool.query(`INSERT INTO reports(property_id,created_by,title,report_type,content)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,[b.property_id,user.id,b.title.trim(),text(b.report_type,100),JSON.stringify(b.content)]);
    return json(res,201,reportLabel(q.rows[0]));
  }

  const imageMatch=url.pathname.match(/^\/api\/reports\/([0-9a-f-]{36})\/images\/([A-Za-z0-9_-]{8,100})$/i);
  if(imageMatch && (method==='GET'||method==='POST')){
    const reportId=imageMatch[1],imageId=imageMatch[2];
    const report=await reportAccess(user,reportId);
    if(method==='POST')throw fail(405,'Bruk bildeopplasting uten bilde-ID');
    if(!imageClient)throw fail(503,'Bildelagring er ikke konfigurert');
    const prefix=imageId.includes('-')&&!/^[0-9a-f-]{36}$/i.test(imageId)?'projects/'+reportLabel(report).report_code+'/'+imageId:'reports/'+reportId+'/'+imageId;
    let object;
    for(const extension of ['.jpg','.png','.webp']){
      try{object=await imageClient.send(new GetObjectCommand({Bucket:imageBucket,Key:prefix+extension}));break}
      catch(e){if(e.name!=='NoSuchKey'&&e.name!=='NotFound')throw e}
    }
    if(!object)throw fail(404,'Bilde ikke funnet');
    res.writeHead(200,{'Content-Type':object.ContentType||'image/jpeg','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});
    for await(const part of object.Body)res.write(part);
    return res.end();
  }
  const imageList=url.pathname.match(/^\/api\/reports\/([0-9a-f-]{36})\/image-list$/i);
  if(imageList && method==='GET'){
    staff(user);
    const report=await reportAccess(user,imageList[1]);
    if(!imageClient)throw fail(503,'Bildelagring er ikke konfigurert');
    const code=reportLabel(report).report_code;
    const result=await imageClient.send(new ListObjectsV2Command({Bucket:imageBucket,Prefix:'projects/'+code+'/',MaxKeys:1000}));
    const images=(result.Contents||[]).filter(x=>/\.(jpg|png|webp)$/i.test(x.Key)).map(x=>({name:x.Key.split('/').pop(),url:imagePath(report.id,x.Key.split('/').pop().replace(/\.(jpg|png|webp)$/i,'')),size:x.Size}));
    return json(res,200,{report_code:code,images});
  }
  const imageUpload=url.pathname.match(/^\/api\/reports\/([0-9a-f-]{36})\/images$/i);
  if(imageUpload && method==='POST'){
    staff(user);const reportId=imageUpload[1];
    const report=await reportAccess(user,reportId);
    if(report.status!=='draft')throw fail(409,'Rapporten er låst');
    guardOrigin(req);
    if(req.headers['content-type']!=='image/jpeg')throw fail(415,'Kun JPEG-bilder støttes');
    let size=0;const parts=[];
    for await(const part of req){size+=part.length;if(size>8*1024*1024)throw fail(413,'Bildet er for stort (maks 8 MB)');parts.push(part)}
    const bytes=Buffer.concat(parts);
    if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)throw fail(400,'Ugyldig JPEG-bilde');
    const kind=(url.searchParams.get('kind')||'funn01').replace(/[^a-z0-9-]/gi,'').slice(0,40);
    return json(res,201,{url:await storeImage(report,bytes,kind)});
  }
  const match=url.pathname.match(/^\/api\/reports\/([0-9a-f-]{36})(?:\/(submit|approve|publish))?$/i);
  if (match) {
    const reportId=match[1],action=match[2];
    const r=await reportAccess(user,reportId);
    if (!action && method==='GET') return json(res,200,reportLabel(r));
    staff(user);
    if (!action && method==='PATCH') {
      if (r.status!=='draft') throw fail(409,'Kun utkast kan endres');
      const b=await body(req);
      if (!text(b.title,300)||!b.content||typeof b.content!=='object'||Array.isArray(b.content)) throw fail(400,'Ugyldig rapport');
      const q=await pool.query(`UPDATE reports SET title=$2,content=$3,updated_at=now()
        WHERE id=$1 AND status='draft' RETURNING *`,[reportId,b.title.trim(),JSON.stringify(await moveEmbeddedImages(reportId,b.content))]);
      if (!q.rowCount) throw fail(409,'Rapportstatus er endret');
      return json(res,200,q.rows[0]);
    }
    if (method==='POST' && action==='submit') {
      const q=await pool.query("UPDATE reports SET status='review',updated_at=now() WHERE id=$1 AND status='draft' RETURNING id,status",[reportId]);
      if (!q.rowCount) throw fail(409,'Rapporten kan ikke sendes til kontroll');
      return json(res,200,q.rows[0]);
    }
    if (method==='POST' && action==='approve') {
      admin(user);
      return json(res,200,await transaction(async c=>{
        const q=await c.query("UPDATE reports SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1 AND status='review' RETURNING *",[reportId,user.id]);
        if (!q.rowCount) throw fail(409,'Rapporten kan ikke godkjennes');
        await c.query(`INSERT INTO report_versions(report_id,version_number,content,created_by)
          VALUES($1,1,$2,$3)`,[reportId,JSON.stringify(q.rows[0].content),user.id]);
        return {id:reportId,status:'approved'};
      }));
    }
    if (method==='POST' && action==='publish') {
      admin(user);
      return json(res,200,await transaction(async c=>{
        const q=await c.query(`UPDATE reports SET status='published',published_by=$2,published_at=now(),updated_at=now()
          WHERE id=$1 AND status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL RETURNING id,property_id,status,published_at`,[reportId,user.id]);
        if (!q.rowCount) throw fail(409,'Kun godkjente rapporter kan overføres');
        return q.rows[0];
      }));
    }
  }
  throw fail(404,'Ikke funnet');
}
await init();
http.createServer((req,res)=>handler(req,res).catch(e=>{
  const code=e.code && Number.isInteger(e.code) ? e.code : e.code==='23503'?400:e.code==='23505'?409:500;
  if(code===500) console.error('Request failed',e);
  json(res,code,{error:code===500?'Intern serverfeil':e.message});
})).listen(port,'0.0.0.0',()=>console.log('Rapport API lytter pa',port));
