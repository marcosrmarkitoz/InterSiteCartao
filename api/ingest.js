// Vercel Serverless Function — /api/ingest
import crypto from 'crypto';

const {
  SF_CLIENT_ID,
  SF_USER_NAME,
  SF_PRIVATE_KEY,
  SF_LOGIN_URL,
  SF_CORE_INSTANCE_URL,
  SF_DATA_CLOUD_URL,
  SF_INGEST_SOURCE,
  SF_DATASET,
} = process.env;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function buildJwt() {
  // Fix: replace literal \n with real newlines in private key
  const privateKey = SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: SF_CLIENT_ID,
    sub: SF_USER_NAME,
    aud: `${SF_LOGIN_URL}/services/oauth2/token`,
    exp: now + 180,
  }));
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const sig = sign.sign(privateKey, 'base64url');
  return `${signingInput}.${sig}`;
}

async function getCoreToken() {
  const jwt = buildJwt();
  console.log('[ingest] requesting core token...');
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Core token failed (${res.status}): ${text}`);
  console.log('[ingest] core token OK');
  return JSON.parse(text).access_token;
}

async function getCdpToken() {
  const coreToken = await getCoreToken();
  console.log('[ingest] requesting CDP token...');
  const res = await fetch(`${SF_CORE_INSTANCE_URL}/services/a360/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:salesforce:grant-type:external:cdp',
      subject_token: coreToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CDP token failed (${res.status}): ${text}`);
  console.log('[ingest] CDP token OK');
  return JSON.parse(text).access_token;
}

async function sendToDataCloud(cdpToken, record) {
  const url = `${SF_DATA_CLOUD_URL}/api/v1/ingest/sources/${SF_INGEST_SOURCE}/${SF_DATASET}`;
  console.log('[ingest] sending to:', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cdpToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [record] }),
  });
  const text = await res.text();
  if (res.status !== 202) throw new Error(`Ingest failed (${res.status}): ${text}`);
  console.log('[ingest] ingest OK 202');
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ message: 'Method not allowed' });

  const body = req.body;
  if (!body || !body.transaction_id) {
    return res.status(400).json({ message: 'Payload inválido — transaction_id obrigatório' });
  }

  const record = {
    ...body,
    event_timestamp: body.event_timestamp || new Date().toISOString(),
    individual_id: body.individual_id || '003Ws00000Q4nxFIAR',
  };

  try {
    const cdpToken = await getCdpToken();
    await sendToDataCloud(cdpToken, record);
    return res.status(200).json({ message: 'Evento enviado com sucesso', transaction_id: record.transaction_id });
  } catch (e) {
    console.error('[ingest] ERRO:', e.message);
    return res.status(502).json({ message: 'Erro ao enviar ao Data Cloud', detail: e.message });
  }
}
