import https from 'https';

function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: options.method || 'POST',
      headers: options.headers || {}
    }, res => {
      let data='';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function sendSms(toPhoneE164, message) {
  const provider = (process.env.SMS_PROVIDER || 'none').toLowerCase();
  if (provider === 'none') return { ok: true, simulated: true };

  if (provider === 'africas_talking') {
    const key = process.env.AFRICAS_TALKING_API_KEY;
    const username = process.env.AFRICAS_TALKING_USERNAME;
    const from = process.env.SMS_FROM || 'TaskPesa';
    if (!key || !username) return { ok: false, error: 'missing_africas_talking_config' };
    const body = new URLSearchParams({ username, to: toPhoneE164, message, from }).toString();
    const res = await doFetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'apiKey': key },
      body
    });
    return { ok: res.status >= 200 && res.status < 300 };
  }

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) return { ok: false, error: 'missing_twilio_config' };
    const body = new URLSearchParams({ To: toPhoneE164, From: from, Body: message }).toString();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body
    });
    return { ok: res.status >= 200 && res.status < 300 };
  }

  return { ok: false, error: 'unknown_provider' };
}
