import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './pg.js';
import { rateLimit } from './ratelimit.js';
import { sendSms } from './send_sms.js';

export const router = express.Router();

function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[\u0000-\u001F\u007F]/g, '').replace(/<\s*script/gi, '');
}

function signJwt(user) {
  return jwt.sign({ userId: user.id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function readToken(req) {
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7);
  if (req.cookies?.tp_jwt) return req.cookies.tp_jwt;
  return null;
}

function auth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

function ensureNotBlocked(userId) {
  return pool
    .query('select blocked from users where id=$1', [userId])
    .then(r => !r.rows[0]?.blocked);
}

function admin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key && key === process.env.ADMIN_KEY) return next();
  res.status(403).json({ error: 'forbidden' });
}

function csrfCheck(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies?.tp_csrf;
  if (!header || !cookie || header !== cookie) return res.status(403).json({ error: 'csrf' });
  next();
}
router.use(csrfCheck);

// Nairobi time helpers
function getNairobiNow() {
  const nowUtc = new Date();
  const ms = nowUtc.getTime() + 3 * 60 * 60 * 1000; // UTC+3
  return new Date(ms);
}
function getTaskDayDateISO() {
  const n = getNairobiNow();
  if (n.getHours() === 0 && n.getMinutes() === 0) {
    const prev = new Date(n);
    prev.setDate(prev.getDate() - 1);
    prev.setHours(0, 0, 0, 0);
    return prev.toISOString();
  }
  const d = new Date(n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function isFridayNairobi() {
  return getNairobiNow().getDay() === 5; // 5=Friday
}

function getCommissionPercent(amt, tiers) {
  if (!Array.isArray(tiers)) return 8;
  for (const t of tiers) {
    if (amt >= t.min && amt <= t.max) return t.percent;
  }
  return 8;
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').replace(/^254/, '0');
}

function toE164KE(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) return `+254${p.slice(1)}`;
  if (p.startsWith('254')) return `+${p}`;
  if (p.startsWith('7')) return `+254${p}`;
  return `+${p}`;
}

// Auth (register/login/logout) with cookie support
router.post('/auth/register', async (req, res) => {
  const ip = req.ip || 'ip';
  if (!rateLimit('register', ip, 10, 60_000)) return res.status(429).json({ error: 'rate_limited' });
  const { phone, password, email, referralCode } = req.body;
  const norm = sanitizePhone(phone);
  if (!norm || !password) return res.status(400).json({ error: 'missing_fields' });
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Generate referral code
    let myCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    for (let i = 0; i < 5; i++) {
      const exists = await client.query('select 1 from users where referral_code=$1', [myCode]);
      if (exists.rowCount === 0) break;
      myCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    }
    const ins = await client.query(
      'insert into users (phone, email, password_hash, referral_code) values ($1,$2,$3,$4) returning id, phone, email, referral_code, created_at, balance_kes, avatar_url',
      [norm, email ? sanitizeString(email) : null, hash, myCode]
    );
    const newUser = ins.rows[0];

    if (referralCode) {
      const ref = await client.query('select id from users where referral_code=$1', [String(referralCode).trim().toUpperCase()]);
      const referrer = ref.rows[0];
      if (referrer) {
        await client.query(
          'insert into referrals (referrer_user_id, referred_user_id) values ($1,$2) on conflict (referred_user_id) do nothing',
          [referrer.id, newUser.id]
        );
      }
    }
    await client.query('commit');
    const token = signJwt(newUser);
    res.cookie('tp_jwt', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7*24*3600*1000 });
    res.json({ token, user: newUser });
  } catch (e) {
    await client.query('rollback');
    if (e.code === '23505') return res.status(409).json({ error: 'phone_or_code_exists' });
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

router.post('/auth/login', async (req, res) => {
  const ip = req.ip || 'ip';
  if (!rateLimit('login', ip, 20, 60_000)) return res.status(429).json({ error: 'rate_limited' });
  const { phone, password } = req.body;
  const norm = sanitizePhone(phone);
  const { rows } = await pool.query('select * from users where phone=$1', [norm]);
  const user = rows[0];
  const now = new Date();
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  if (user.blocked) return res.status(403).json({ error: 'blocked' });
  if (user.locked_until && new Date(user.locked_until) > now) return res.status(423).json({ error: 'account_locked' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const failed = (user.failed_login_attempts || 0) + 1;
    const lockedUntil = failed >= 5 ? new Date(now.getTime() + 30 * 60 * 1000) : null;
    await pool.query('update users set failed_login_attempts=$1, locked_until=$2 where id=$3', [failed, lockedUntil, user.id]);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  await pool.query('update users set failed_login_attempts=0, locked_until=null where id=$1', [user.id]);
  const token = signJwt(user);
  res.cookie('tp_jwt', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7*24*3600*1000 });
  res.json({ token, user: { id: user.id, phone: user.phone, email: user.email, created_at: user.created_at, balance_kes: user.balance_kes, avatar_url: user.avatar_url } });
});

router.post('/auth/logout', (_req, res) => {
  res.clearCookie('tp_jwt');
  res.json({ ok: true });
});

// OTP password reset
router.post('/auth/request-otp', auth, async (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rows: u } = await pool.query('select phone from users where id=$1', [req.user.userId]);
  const phone = u[0]?.phone;
  if (!phone) return res.status(400).json({ error: 'no_phone' });
  await pool.query('insert into verifications (user_id, phone, code, expires_at) values ($1,$2,$3,$4)', [req.user.userId, phone, code, expires.toISOString()]);
  await sendSms(toE164KE(phone), `TaskPesa OTP: ${code}`);
  res.json({ sent: true });
});
router.post('/auth/request-password-reset', async (req, res) => {
  const { phone } = req.body;
  const norm = String(phone || '').replace(/\D/g, '').replace(/^254/,'0');
  const { rows } = await pool.query('select id from users where phone=$1', [norm]);
  if (!rows[0]) return res.json({ sent: true });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query('insert into verifications (user_id, phone, code, expires_at) values ($1,$2,$3,$4)', [rows[0].id, norm, code, expires.toISOString()]);
  await sendSms(toE164KE(norm), `TaskPesa reset OTP: ${code}`);
  res.json({ sent: true });
});
router.post('/auth/verify-password-reset', async (req, res) => {
  const { phone, code, newPassword } = req.body;
  const norm = sanitizePhone(phone);
  const { rows: u } = await pool.query('select id from users where phone=$1', [norm]);
  const user = u[0];
  if (!user) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query('select * from verifications where user_id=$1 order by id desc limit 1', [user.id]);
  const v = rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  if (String(v.code) !== String(code) || new Date(v.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_code' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('update users set password_hash=$1 where id=$2', [hash, user.id]);
  res.json({ ok: true });
});

// Referral stats
router.get('/referrals', auth, async (req, res) => {
  const [mine, summary] = await Promise.all([
    pool.query('select r.*, u.phone as referred_phone from referrals r join users u on u.id=r.referred_user_id where r.referrer_user_id=$1 order by r.id desc', [req.user.userId]).then(r=>r.rows),
    pool.query('select count(*)::int as total, coalesce(sum(reward_kes),0)::int as rewards from referrals where referrer_user_id=$1', [req.user.userId]).then(r=>r.rows[0])
  ]);
  const me = await pool.query('select referral_code from users where id=$1', [req.user.userId]);
  res.json({ referralCode: me.rows[0]?.referral_code || null, total: summary.total, rewardsKes: summary.rewards, referrals: mine });
});
router.get('/admin/referrals', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query('select * from referrals order by id desc limit $1 offset $2', [limit, offset]);
  res.json(rows);
});

// Purchase: deduct from deposit remaining_kes (partial allowed)
router.post('/purchase', auth, async (req, res) => {
  const { packageId, depositId } = req.body;
  if (!packageId || !depositId) return res.status(400).json({ error: 'missing_fields' });
  const { rows: p } = await pool.query('select * from packages where id=$1', [packageId]);
  const pkg = p[0];
  if (!pkg) return res.status(404).json({ error: 'package_not_found' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const depRes = await client.query('select * from deposits where id=$1 and user_id=$2 for update', [depositId, req.user.userId]);
    const dep = depRes.rows[0];
    if (!dep) { await client.query('rollback'); return res.status(404).json({ error: 'deposit_not_found' }); }
    if (dep.status !== 'verified' && dep.status !== 'used') { await client.query('rollback'); return res.status(400).json({ error: 'deposit_not_usable' }); }
    const remaining = dep.remaining_kes ?? dep.amount_kes;
    if (remaining < pkg.price_kes) { await client.query('rollback'); return res.status(400).json({ error: 'insufficient_deposit' }); }

    const now = getNairobiNow();
    const end = new Date(now);
    end.setDate(end.getDate() + pkg.duration_days);

    const ins = await client.query(
      'insert into purchases (user_id, package_id, start_date, end_date, is_active, deposit_id) values ($1,$2,$3,$4,true,$5) returning *',
      [req.user.userId, pkg.id, now.toISOString(), end.toISOString(), depositId]
    );
    const newRemain = remaining - pkg.price_kes;
    await client.query('update deposits set remaining_kes=$1, status=case when $1=0 then \'used\' else \'verified\' end where id=$2', [newRemain, depositId]);
    await client.query('commit');
    res.json(ins.rows[0]);
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Loyalty bonus cron-safe endpoint (admin)
router.post('/admin/bonuses/run', admin, async (_req, res) => {
  const cfgRes = await pool.query("select value from settings where key='loyalty'");
  const cfg = cfgRes.rows[0]?.value || { completion_percent: 5 };
  // find purchases that ended in last 2 days and not bonus-awarded (by scanning ledger notes)
  const { rows: purchases } = await pool.query(
    `select pu.id, pu.user_id, pu.start_date, pu.end_date, pa.price_kes, pa.tasks_per_day
     from purchases pu join packages pa on pa.id=pu.package_id
     where pu.end_date <= now() and pu.end_date >= now() - interval '2 days'`
  );
  let awarded = 0;
  for (const pu of purchases) {
    // check if already awarded
    const exists = await pool.query("select 1 from ledger where type='loyalty_bonus' and ref_id=$1", [pu.id]);
    if (exists.rowCount > 0) continue;
    // count distinct days with approved submissions within window
    const { rows: cnt } = await pool.query(
      `select count(distinct date(submitted_at))::int as days
       from submissions where user_id=$1 and status='approved' and submitted_at between $2 and $3`,
      [pu.user_id, pu.start_date, pu.end_date]
    );
    if (cnt[0].days >= 10) {
      const bonus = Math.round((pu.price_kes * (cfg.completion_percent || 5)) / 100);
      const bal = await pool.query('update users set balance_kes = balance_kes + $1 where id=$2 returning balance_kes', [bonus, pu.user_id]);
      await pool.query('insert into ledger (user_id, type, amount_kes, balance_after, ref_id, notes) values ($1,$2,$3,$4,$5,$6)', [pu.user_id, 'loyalty_bonus', bonus, bal.rows[0].balance_kes, pu.id, `loyalty ${cfg.completion_percent}%`]);
      awarded++;
    }
  }
  res.json({ ok: true, awarded });
});

// Blocked middleware
router.use(async (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const allowed = await ensureNotBlocked(payload.userId);
    if (!allowed) return res.status(403).json({ error: 'blocked' });
    next();
  } catch {
    next();
  }
});

// Profile
router.get('/me', auth, async (req, res) => {
  const { rows } = await pool.query('select id, phone, email, created_at, balance_kes, avatar_url, phone_verified_at from users where id=$1', [req.user.userId]);
  const { rows: activePkg } = await pool.query(
    `select pa.name, pa.price_kes, pa.tasks_per_day, pa.task_type, pu.start_date, pu.end_date
     from purchases pu join packages pa on pa.id = pu.package_id
     where pu.user_id=$1 and pu.is_active=true and pu.end_date >= now()
     order by pu.start_date desc limit 1`,
    [req.user.userId]
  );
  res.json({ user: rows[0] || null, activePackage: activePkg[0] || null });
});
router.put('/me/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'weak_password' });
  const { rows } = await pool.query('select password_hash from users where id=$1', [req.user.userId]);
  const ok = rows[0] && (await bcrypt.compare(oldPassword, rows[0].password_hash));
  if (!ok) return res.status(401).json({ error: 'invalid_old_password' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('update users set password_hash=$1 where id=$2', [hash, req.user.userId]);
  res.json({ ok: true });
});
router.put('/me/avatar', auth, async (req, res) => {
  const { avatarUrl } = req.body;
  await pool.query('update users set avatar_url=$1 where id=$2', [sanitizeString(avatarUrl) || null, req.user.userId]);
  res.json({ ok: true });
});
router.delete('/me', auth, async (req, res) => {
  await pool.query('delete from users where id=$1', [req.user.userId]);
  res.json({ ok: true });
});

// Packages
router.get('/packages', async (_req, res) => {
  const { rows } = await pool.query('select id, name, price_kes, tasks_per_day, task_type, duration_days from packages order by price_kes');
  res.json(rows);
});

// Deposits (manual), with proof_url
router.post('/deposits', auth, async (req, res) => {
  const userKey = `dep:${req.user.userId}`;
  if (!rateLimit('deposit', userKey, 5, 60 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
  const { mpesaCode, amountKes, proofUrl } = req.body;
  if (!mpesaCode || !amountKes) return res.status(400).json({ error: 'missing_fields' });
  try {
    const { rows } = await pool.query(
      'insert into deposits (user_id, mpesa_code, amount_kes, till_number, proof_url, status) values ($1,$2,$3,$4,$5,$6) returning *',
      [req.user.userId, String(mpesaCode).trim(), Number(amountKes), '4567052', proofUrl ? sanitizeString(proofUrl) : null, 'pending']
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code_exists' });
    res.status(500).json({ error: 'server_error' });
  }
});
router.get('/deposits', auth, async (req, res) => {
  const { rows } = await pool.query('select * from deposits where user_id=$1 order by id desc', [req.user.userId]);
  res.json(rows);
});
router.get('/admin/deposits', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const status = req.query.status;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const conds = [];
  const params = [];
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  if (userId) { params.push(userId); conds.push(`user_id=$${params.length}`); }
  params.push(limit); params.push(offset);
  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  const sql = `select * from deposits ${where} order by id desc limit $${params.length-1} offset $${params.length}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});
router.post('/admin/deposits/:id/verify', admin, async (req, res) => {
  const id = Number(req.params.id);
  const adminIp = req.ip;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const depRes = await client.query('select * from deposits where id=$1 for update', [id]);
    const dep = depRes.rows[0];
    if (!dep || dep.status !== 'pending') {
      await client.query('rollback');
      return res.status(404).json({ error: 'not_found_or_not_pending' });
    }
    await client.query("update deposits set status='verified', verified_at=now(), remaining_kes=coalesce(remaining_kes, amount_kes) where id=$1", [id]);
    await client.query('insert into admin_audit_logs (action, admin_ip, target_user_id, payload) values ($1,$2,$3,$4)', ['deposit_verify', adminIp, dep.user_id, JSON.stringify({ depositId: dep.id })]);
    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});
router.post('/admin/deposits/:id/reject', admin, async (req, res) => {
  const id = Number(req.params.id);
  const adminIp = req.ip;
  const { rows } = await pool.query(
    `update deposits set status='rejected' where id=$1 and status in ('pending') returning *`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('insert into admin_audit_logs (action, admin_ip, target_user_id, payload) values ($1,$2,$3,$4)', ['deposit_reject', adminIp, rows[0].user_id, JSON.stringify({ depositId: id })]);
  res.json(rows[0]);
});

// Purchases — require verified deposit; do not use balance
router.post('/purchase', auth, async (req, res) => {
  const { packageId, depositId } = req.body;
  if (!packageId || !depositId) return res.status(400).json({ error: 'missing_fields' });

  const { rows: p } = await pool.query('select * from packages where id=$1', [packageId]);
  const pkg = p[0];
  if (!pkg) return res.status(404).json({ error: 'package_not_found' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const depRes = await client.query('select * from deposits where id=$1 and user_id=$2 for update', [depositId, req.user.userId]);
    const dep = depRes.rows[0];
    if (!dep) { await client.query('rollback'); return res.status(404).json({ error: 'deposit_not_found' }); }
    if (dep.status !== 'verified') { await client.query('rollback'); return res.status(400).json({ error: 'deposit_not_verified' }); }
    if (dep.amount_kes < pkg.price_kes) { await client.query('rollback'); return res.status(400).json({ error: 'insufficient_deposit' }); }

    const now = getNairobiNow();
    const end = new Date(now);
    end.setDate(end.getDate() + pkg.duration_days);

    const ins = await client.query(
      'insert into purchases (user_id, package_id, start_date, end_date, is_active, deposit_id) values ($1,$2,$3,$4,true,$5) returning *',
      [req.user.userId, pkg.id, now.toISOString(), end.toISOString(), depositId]
    );
    await client.query("update deposits set status='used' where id=$1", [depositId]);
    await client.query('commit');
    res.json(ins.rows[0]);
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Admin: block/unblock users
router.post('/admin/users/:id/block', admin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('update users set blocked=true where id=$1', [id]);
  await pool.query('insert into admin_audit_logs (action, admin_ip, target_user_id, payload) values ($1,$2,$3,$4)', ['user_block', req.ip, id, JSON.stringify({})]);
  res.json({ ok: true });
});
router.post('/admin/users/:id/unblock', admin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('update users set blocked=false where id=$1', [id]);
  await pool.query('insert into admin_audit_logs (action, admin_ip, target_user_id, payload) values ($1,$2,$3,$4)', ['user_unblock', req.ip, id, JSON.stringify({})]);
  res.json({ ok: true });
});

// Admin: create task template
router.post('/admin/tasks', admin, async (req, res) => {
  const { title, description, taskType, rewardKes = 10, completionTimeLimitSec = 300, active = true } = req.body;
  if (!title || !taskType) return res.status(400).json({ error: 'missing_fields' });
  const { rows } = await pool.query(
    'insert into tasks (title, description, task_type, reward_kes, completion_time_limit_sec, active) values ($1,$2,$3,$4,$5,$6) returning *',
    [sanitizeString(title), sanitizeString(description || ''), taskType, Number(rewardKes), Number(completionTimeLimitSec), !!active]
  );
  await pool.query('insert into admin_audit_logs (action, admin_ip, payload) values ($1,$2,$3)', ['task_create', req.ip, JSON.stringify({ taskId: rows[0].id })]);
  res.json(rows[0]);
});

// Admin: generate daily tasks
router.post('/admin/tasks/generate-daily', admin, async (_req, res) => {
  const todayISO = getTaskDayDateISO();
  const day = new Date(todayISO);
  const dayDate = day.toISOString().slice(0, 10);
  const { rows: existing } = await pool.query('select count(*)::int as c from tasks where created_on=$1', [dayDate]);
  if (existing[0].c > 0) return res.json({ ok: true, message: 'already_generated' });

  const seed = [];
  for (let i = 0; i < 100; i++) {
    const types = ['basic','standard','premium','bonus'];
    const type = types[i % types.length];
    const reward = type === 'basic' ? 10 : type === 'standard' ? 20 : type === 'premium' ? 50 : 100;
    seed.push({ t: `Task ${i+1} — ${type}`, d: 'Kenyan-relevant virtual task', type, r: reward });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const s of seed) {
      await client.query(
        'insert into tasks (title, description, task_type, reward_kes, completion_time_limit_sec, active, created_on) values ($1,$2,$3,$4,$5,$6,$7)',
        [s.t, s.d, s.type, s.r, 600, true, dayDate]
      );
    }
    await client.query('insert into admin_audit_logs (action, admin_ip, payload) values ($1,$2,$3)', ['tasks_generate_daily', 'cron', JSON.stringify({ day: dayDate, created: seed.length })]);
    await client.query('commit');
    res.json({ ok: true, created: seed.length });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Daily tasks (assign if needed)
router.get('/tasks/today', auth, async (req, res) => {
  const { rows: purchaseRows } = await pool.query(
    `select pu.*, pa.tasks_per_day, pa.task_type from purchases pu
     join packages pa on pa.id = pu.package_id
     where pu.user_id=$1 and pu.is_active=true and pu.end_date >= now()
     order by pu.start_date desc limit 1`,
    [req.user.userId]
  );
  const purchase = purchaseRows[0];
  if (!purchase) return res.json([]);

  const dayISO = getTaskDayDateISO();

  const { rows: existing } = await pool.query(
    'select ta.id from task_assignments ta where user_id=$1 and assigned_for_date=$2',
    [req.user.userId, dayISO]
  );

  if (existing.length === 0) {
    const { rows: poolTasks } = await pool.query(
      `select id from tasks where active=true and task_type=$1 and created_on >= (now() at time zone 'utc')::date - interval '1 day' order by id desc limit $2`,
      [purchase.task_type, purchase.tasks_per_day]
    );
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const t of poolTasks) {
        await client.query(
          'insert into task_assignments (user_id, task_id, assigned_for_date) values ($1,$2,$3)',
          [req.user.userId, t.id, dayISO]
        );
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }

  const { rows: assignments } = await pool.query(
    `select ta.id as assignment_id, ta.assigned_at, t.id as task_id, t.title, t.description, t.task_type, t.reward_kes, t.completion_time_limit_sec,
            coalesce(s.status,'pending') as status
     from task_assignments ta
     join tasks t on t.id = ta.task_id
     left join submissions s on s.assignment_id = ta.id
     where ta.user_id=$1 and ta.assigned_for_date=$2`,
    [req.user.userId, dayISO]
  );
  res.json(assignments);
});

router.post('/tasks/submit', auth, async (req, res) => {
  const userKey = `sub:${req.user.userId}`;
  if (!rateLimit('submit', userKey, 30, 60 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
  const { assignmentId, proofUrl, text } = req.body;
  const { rows: dup } = await pool.query('select id from submissions where assignment_id=$1', [assignmentId]);
  if (dup[0]) return res.status(409).json({ error: 'already_submitted' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const assign = await client.query(
      `select ta.id, ta.user_id, ta.task_id, ta.assigned_at, t.reward_kes, t.task_type, t.completion_time_limit_sec
       from task_assignments ta join tasks t on t.id=ta.task_id where ta.id=$1 and ta.user_id=$2 for update`,
      [assignmentId, req.user.userId]
    );
    const a = assign.rows[0];
    if (!a) { await client.query('rollback'); return res.status(404).json({ error: 'assignment_not_found' }); }

    const ttlMs = (a.completion_time_limit_sec || 300) * 1000;
    if (Date.now() - new Date(a.assigned_at).getTime() > ttlMs) {
      await client.query('rollback');
      return res.status(400).json({ error: 'time_limit_exceeded' });
    }

    const txt = typeof text === 'string' ? text.trim() : '';
    const words = txt ? txt.split(/\s+/).length : 0;
    const proof = proofUrl ? String(proofUrl) : '';
    let valid = true;
    if (a.task_type === 'basic') valid = true;
    else if (a.task_type === 'standard') valid = words >= 20;
    else if (a.task_type === 'premium') valid = proof.startsWith('http');
    else if (a.task_type === 'bonus') valid = (words >= 30 && proof.startsWith('http'));
    if (!valid) { await client.query('rollback'); return res.status(400).json({ error: 'validation_failed' }); }

    await client.query(
      `insert into submissions (assignment_id, user_id, task_id, submitted_at, status, proof_url)
       values ($1,$2,$3,now(),'approved',$4)`,
      [a.id, req.user.userId, a.task_id, proof || null]
    );
    const newBal = await client.query('update users set balance_kes = balance_kes + $1 where id=$2 returning balance_kes', [a.reward_kes, req.user.userId]);
    await client.query('insert into task_history (user_id, task_id, reward_kes, notes) values ($1,$2,$3,$4)', [req.user.userId, a.task_id, a.reward_kes, 'auto-verified']);
    await client.query('insert into ledger (user_id, type, amount_kes, balance_after, ref_id, notes) values ($1,$2,$3,$4,$5,$6)', [req.user.userId, 'task_reward', a.reward_kes, newBal.rows[0].balance_kes, a.task_id, 'task reward']);
    await client.query('commit');
    res.json({ ok: true, reward_kes: a.reward_kes });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Withdrawals
router.post('/withdrawals/request', auth, async (req, res) => {
  const userKey = `wd:${req.user.userId}`;
  if (!rateLimit('withdraw', userKey, 5, 60 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
  const { amountKes } = req.body;
  const amt = Number(amountKes || 0);
  if (!isFridayNairobi()) return res.status(400).json({ error: 'friday_only' });
  const s = await pool.query("select key, value from settings where key in ('withdrawal','commissions','withdrawalApprovalMode')");
  const set = Object.fromEntries(s.rows.map(r => [r.key, r.value]));
  const limits = set.withdrawal || { min_kes: 750, max_kes: 10000 };
  if (amt < limits.min_kes || amt > limits.max_kes) return res.status(400).json({ error: 'limits', min: limits.min_kes, max: limits.max_kes });
  const tiers = set.commissions?.tiers || [];
  const pct = getCommissionPercent(amt, tiers);
  const fee = Math.round((amt * pct) / 100);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const balRes = await client.query('select balance_kes from users where id=$1 for update', [req.user.userId]);
    const bal = balRes.rows[0]?.balance_kes ?? 0;
    if (bal < amt) { await client.query('rollback'); return res.status(400).json({ error: 'insufficient_balance' }); }
    const newBal = await client.query('update users set balance_kes = balance_kes - $1 where id=$2 returning balance_kes', [amt, req.user.userId]);
    let status = 'pending';
    if (set.withdrawalApprovalMode?.mode === 'auto') status = 'approved';
    const ins = await client.query(
      'insert into withdrawals (user_id, amount_kes, fee_kes, status, requested_at, processed_at, payout_ref) values ($1,$2,$3,$4,now(), case when $4=\'approved\' then now() else null end, case when $4=\'approved\' then \'+sandbox\' else null end) returning *',
      [req.user.userId, amt, fee, status]
    );
    await client.query('insert into ledger (user_id, type, amount_kes, balance_after, ref_id, notes) values ($1,$2,$3,$4,$5,$6)', [req.user.userId, 'withdrawal_request', -amt, newBal.rows[0].balance_kes, ins.rows[0].id, `fee ${fee}`]);
    await client.query('commit');
    res.json(ins.rows[0]);
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Admin lists/actions
router.get('/admin/users', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const phone = req.query.phone ? String(req.query.phone) : '';
  const params = [];
  let where = '';
  if (phone) { params.push(`%${phone}%`); where = `where phone like $1`; }
  params.push(limit); params.push(offset);
  const sql = `${where ? 'select id, phone, email, created_at, balance_kes, blocked from users '+where+' order by id desc limit $2 offset $3' : 'select id, phone, email, created_at, balance_kes, blocked from users order by id desc limit $1 offset $2'}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});
router.get('/admin/tasks', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Number(req.query.offset || 0);
  const type = req.query.type;
  const params = [];
  let where = '';
  if (type) { params.push(type); where = 'where task_type=$1'; }
  params.push(limit); params.push(offset);
  const sql = `${where ? 'select * from tasks '+where+' order by id desc limit $2 offset $3' : 'select * from tasks order by id desc limit $1 offset $2'}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});
router.get('/admin/submissions', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query('select * from submissions order by id desc limit $1 offset $2', [limit, offset]);
  res.json(rows);
});
router.get('/admin/withdrawals', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Number(req.query.offset || 0);
  const status = req.query.status;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const conds = [];
  const params = [];
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  if (userId) { params.push(userId); conds.push(`user_id=$${params.length}`); }
  params.push(limit); params.push(offset);
  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  const sql = `select * from withdrawals ${where} order by id desc limit $${params.length-1} offset $${params.length}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/admin/withdrawals/:id/approve', admin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(
    `update withdrawals set status='approved', processed_at=now(), payout_ref='+sandbox' where id=$1 and status='pending' returning *`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found_or_not_pending' });
  await pool.query('insert into admin_audit_logs (action, admin_ip, target_user_id, payload) values ($1,$2,$3,$4)', ['withdraw_approve', req.ip, rows[0].user_id, JSON.stringify({ withdrawalId: id })]);
  res.json(rows[0]);
});

router.get('/admin/settings', admin, async (_req, res) => {
  const { rows } = await pool.query('select key, value from settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});
router.put('/admin/settings/:key', admin, async (req, res) => {
  const key = req.params.key;
  const value = req.body;
  const { rows } = await pool.query(
    'insert into settings(key, value) values ($1,$2) on conflict (key) do update set value=excluded.value returning key, value',
    [key, value]
  );
  await pool.query('insert into admin_audit_logs (action, admin_ip, payload) values ($1,$2,$3)', ['settings_update', req.ip, JSON.stringify({ key })]);
  res.json(rows[0]);
});

router.get('/admin/analytics', admin, async (_req, res) => {
  const [[users], [purchases], [active], [deposits], [withdrawals], [pendingW], [approvedW], [tasksCompleted]] = await Promise.all([
    pool.query('select count(*)::int as count from users').then(r=>r.rows[0]),
    pool.query('select count(*)::int as count from purchases').then(r=>r.rows[0]),
    pool.query("select count(*)::int as count from purchases where is_active=true and end_date>=now()").then(r=>r.rows[0]),
    pool.query("select coalesce(sum(amount_kes),0)::int as sum from deposits where status in ('verified','used')").then(r=>r.rows[0]),
    pool.query("select coalesce(sum(amount_kes),0)::int as sum from withdrawals where status in ('approved')").then(r=>r.rows[0]),
    pool.query("select count(*)::int as count from withdrawals where status='pending'").then(r=>r.rows[0]),
    pool.query("select count(*)::int as count from withdrawals where status='approved'").then(r=>r.rows[0]),
    pool.query('select count(*)::int as count from submissions where status=\'approved\'').then(r=>r.rows[0])
  ]);
  res.json({
    users: users.count,
    purchases: purchases.count,
    activePlans: active.count,
    depositsKes: deposits.sum,
    withdrawalsKes: withdrawals.sum,
    withdrawalsPending: pendingW.count,
    withdrawalsApproved: approvedW.count,
    tasksCompleted: tasksCompleted.count
  });
});

// Cron endpoints
router.post('/admin/cron/deactivate-expired', admin, async (_req, res) => {
  const { rowCount } = await pool.query("update purchases set is_active=false where is_active=true and end_date < now()");
  res.json({ ok: true, deactivated: rowCount });
});
router.post('/admin/cron/generate-daily', admin, async (req, res) => {
  req.url = '/admin/tasks/generate-daily';
  req.method = 'POST';
  res.app._router.handle(req, res);
});

router.get('/ledger', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query('select type, amount_kes, balance_after, ref_id, notes, created_at from ledger where user_id=$1 order by id desc limit $2 offset $3', [req.user.userId, limit, offset]);
  res.json(rows);
});

router.get('/admin/ledgers', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const offset = Number(req.query.offset || 0);
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const q = userId ? 'where user_id=$1' : '';
  const params = userId ? [userId, limit, offset] : [limit, offset];
  const sql = userId ? `select * from ledger ${q} order by id desc limit $2 offset $3` : 'select * from ledger order by id desc limit $1 offset $2';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.get('/admin/audits', admin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query('select * from admin_audit_logs order by id desc limit $1 offset $2', [limit, offset]);
  res.json(rows);
});
