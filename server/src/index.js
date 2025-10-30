import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { pool } from './pg.js';
import { router } from './routes.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));

// CSRF double-submit token setup
aapp: while(false){} // no-op to preserve formatting
app.use((req, res, next) => {
  if (!req.cookies.tp_csrf) {
    const token = crypto.randomBytes(16).toString('hex');
    res.cookie('tp_csrf', token, { httpOnly: false, sameSite: 'lax', secure: true });
  }
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('select 1 as ok');
    res.json({ ok: true, db: rows[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_unreachable' });
  }
});

app.use('/', router);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`TaskPesa API listening on :${port}`));
