// Vercel Serverless Function — /api/ingest
// Replica exatamente o fluxo de auth do app Flutter (inter_app):
//   1. JWT Bearer → Core Access Token  (login.salesforce.com)
//   2. Core Token → CDP Token          (coreInstanceUrl/services/a360/token)
//   3. POST Data Cloud Ingestion API   (dataCloudInstanceUrl/api/v1/ingest/sources/...)
//
// Dataset novo: transacao_cartao_credito
// ingestSource: MobileAppTrackingEvents  (mesmo do app)

import crypto from 'crypto';

// ── Variáveis de ambiente (configurar no Vercel) ─────────────────────────────
const {
  SF_CLIENT_ID,           // Connected App consumer key
  SF_USER_NAME,           // Username JWT sub
  SF_PRIVATE_KEY,         // Conteúdo do host_rsa.key (PEM, \n reais)
  SF_LOGIN_URL,           // https://login.salesforce.com
  SF_CORE_INSTANCE_URL,   // https://storm-fc56eb8d8955c3.my.salesforce.com
  SF_DATA_CLOUD_URL,      // https://mq2wknztmjrdkyjygzqwkyjwgm.c360a.salesforce.com
  SF_INGEST_SOURCE,       // MobileAppTrackingEvents
  SF_DATASET,             // transacao_cartao_credito
} = process.env;

// ── Utilitários JWT ───────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function buildJwt() {
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
  const sig = sign.sign(SF_PRIVATE_KEY, 'base64url');
  return `${signingInput}.${sig}`;
}

// ── Passo 1: Core Access Token via JWT Bearer ─────────────────────────────────
async function getCoreToken() {
  const jwt = buildJwt();
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Core token failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── Passo 2: CDP Token via token exchange ──────────────────────────────────────
async function getCdpToken() {
  const coreToken = await getCoreToken();
  const res = await fetch(`${SF_CORE_INSTANCE_URL}/services/a360/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:salesforce:grant-type:external:cdp',
      subject_token: coreToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }),
  });
  if (!res.ok) throw new Error(`CDP token failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── Passo 3: Ingestion API ─────────────────────────────────────────────────────
async function sendToDataCloud(cdpToken, record) {
  const url = `${SF_DATA_CLOUD_URL}/api/v1/ingest/sources/${SF_INGEST_SOURCE}/${SF_DATASET}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cdpToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [record] }),
  });
  if (res.status !== 202) throw new Error(`Ingest failed ${res.status}: ${await res.text()}`);
  return true;
}

// ── Handler principal ──────────────────────────────────────────────────────────
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
  };

  try {
    const cdpToken = await getCdpToken();
    await sendToDataCloud(cdpToken, record);
    return res.status(200).json({ message: 'Evento enviado com sucesso', transaction_id: record.transaction_id });
  } catch (e) {
    console.error('[ingest] erro:', e.message);
    return res.status(502).json({ message: 'Erro ao enviar ao Data Cloud', detail: e.message });
  }
}
