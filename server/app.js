import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, ownerOnly, csrfGuard } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import productRoutes, { stockRouter } from './routes/products.js';
import customerRoutes from './routes/customers.js';
import billRoutes from './routes/bills.js';
import reportRoutes, { dashboardRouter } from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import publicRoutes from './routes/public.js';
import trackingRoutes from './routes/tracking.js';
import dayBookRoutes from './routes/daybook.js';
import bookingRoutes, { teamRouter } from './routes/bookings.js';
import viewRoutes from './routes/view.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  }
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', csrfGuard);
  app.use('/api/auth', authRoutes);
  // A team login sees only the jobs, through /api/view; everything else is the owner's.
  app.use('/api/view', requireAuth, viewRoutes);
  app.use('/api/dashboard', requireAuth, ownerOnly, dashboardRouter);
  app.use('/api/products', requireAuth, ownerOnly, productRoutes);
  app.use('/api/stock', requireAuth, ownerOnly, stockRouter);
  app.use('/api/customers', requireAuth, ownerOnly, customerRoutes);
  app.use('/api/bills', requireAuth, ownerOnly, billRoutes);
  app.use('/api/tracking', requireAuth, ownerOnly, trackingRoutes);
  app.use('/api/day-book', requireAuth, ownerOnly, dayBookRoutes);
  app.use('/api/bookings', requireAuth, ownerOnly, bookingRoutes);
  app.use('/api/team', requireAuth, ownerOnly, teamRouter);
  app.use('/api/reports', requireAuth, ownerOnly, reportRoutes);
  app.use('/api/settings', requireAuth, ownerOnly, settingsRoutes);
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  app.use('/i', publicRoutes);
  app.use('/vendor/inter', express.static(path.join(ROOT, 'node_modules', '@fontsource-variable', 'inter'), { maxAge: '30d' }));
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // Single-page app: every other GET serves the shell; the client router takes over.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.too.large') {
      status = 413;
      message = 'That upload is too large.';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'The request could not be read. Please try again.';
    } else if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: stock_movements/.test(err.message)) {
      status = 409;
      message = 'Stock for this bill has already been updated.';
    } else if (!(err instanceof HttpError) && status >= 500) {
      console.error(err);
      message = 'Something went wrong on our side. Please try again.';
    }
    if (res.headersSent) return next(err);
    if (req.originalUrl.startsWith('/api')) {
      return res.status(status).json({ error: { message, field: err.field, code: err.code, details: err.details } });
    }
    res.status(status).type('text/plain').send(message);
  });

  return app;
}
