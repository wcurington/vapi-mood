/**
 * Health America Backend — server_v2.6.3.js
 * Adds /telephony/play endpoint for SignalWire TTS redirect
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const pinoHttp = require('pino-http');
const winston = require('winston');
const xml = require('xml'); // npm install xml

// Core imports
const constitutional = require('./constitutional.json');
const rebuttals = require('./rebuttals.json');
const { validateCard, validateBank } = require('./validator.js');
const { filterResponse, interceptUser } = require('./server_speech_filter.js');
const orders = require('./models_orders');
const db = require('./db');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8880;
const app = express();

/* --------------------------- Logging setup --------------------------- */
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'server-alex' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

/* ----------------------------- Middleware ----------------------------- */
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 120 }));
app.use(pinoHttp({ customProps: (req) => ({ reqid: req.id }) }));

/* ------------------------------- Health ------------------------------- */
app.get(['/','/health'], (req,res) => {
  res.json({ status:'UP', service:'Server Alex', version:'2.6.3' });
});

/* -------------------------- Orders API stubs -------------------------- */
app.post('/api/orders/create', async (req,res) => {
  try {
    const { full_name, phone, email, call_id, items, discount_pct = 0, payment_method } = req.body || {};
    if (!full_name || !items || !items.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const customer = await orders.createCustomer({ full_name, phone, email });
    const total = items.reduce((sum,it)=>sum+(it.quantity*it.unit_price),0);
    const order = await orders.createOrder({ customer_id: customer.id, call_id, total_amount: total, discount_pct, payment_method });
    const orderItems = [];
    for (const it of items) orderItems.push(await orders.addOrderItem(order.id, it));
    res.json({ ...order, customer, items: orderItems });
  } catch (e) {
    logger.error('[orders/create]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id', async (req,res) => {
  try {
    const order = await orders.getOrderWithItems(req.params.id);
    if (!order) return res.status(404).json({ error:'not found' });
    res.json(order);
  } catch (e) {
    logger.error('[orders/:id]', e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- SignalWire Telephony Redirect ---------------- */
app.post('/telephony/play', (req, res) => {
  const ttsUrl = req.body.ttsUrl || req.query.ttsUrl;
  if (!ttsUrl) return res.status(400).send('Missing ttsUrl parameter');

  const responseXml = xml({
    Response: [
      { Redirect: [{ _attr: { method: 'POST' } }, ttsUrl] }
    ]
  }, { declaration: true });

  res.set('Content-Type', 'application/xml');
  res.send(responseXml);
});

/* --------------------------- Error handlers --------------------------- */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
app.listen(PORT, "0.0.0.0", () => console.log(`App running on port ${PORT}`));
