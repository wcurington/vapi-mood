/**
 * models_orders.js — Order/Customer data access layer
 */
'use strict';

const db = require('./db'); // uses pg Pool

/* ---------------- Customers ---------------- */
async function createCustomer({ full_name, phone, email }) {
  const q = `
    INSERT INTO customers (full_name, phone, email)
    VALUES ($1, $2, $3)
    RETURNING *`;
  const { rows } = await db.query(q, [full_name, phone, email]);
  return rows[0];
}

/* ---------------- Orders ---------------- */
async function createOrder({ customer_id, call_id, total_amount, discount_pct, payment_method }) {
  const q = `
    INSERT INTO orders (customer_id, call_id, total_amount, discount_pct, payment_method)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`;
  const { rows } = await db.query(q, [customer_id, call_id, total_amount, discount_pct, payment_method]);
  return rows[0];
}

async function updateOrderStatus(order_id, status, payment_status = null) {
  const q = `
    UPDATE orders
    SET status=$2, payment_status=COALESCE($3, payment_status)
    WHERE id=$1
    RETURNING *`;
  const { rows } = await db.query(q, [order_id, status, payment_status]);
  return rows[0];
}

/* ---------------- Order Items ---------------- */
async function addOrderItem(order_id, { sku, product_name, quantity, unit_price }) {
  const line_total = quantity * unit_price;
  const q = `
    INSERT INTO order_items (order_id, sku, product_name, quantity, unit_price, line_total)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`;
  const { rows } = await db.query(q, [order_id, sku, product_name, quantity, unit_price, line_total]);
  return rows[0];
}

async function getOrderWithItems(order_id) {
  const q = `
    SELECT o.*, json_agg(oi.*) AS items
    FROM orders o
    LEFT JOIN order_items oi ON o.id = oi.order_id
    WHERE o.id=$1
    GROUP BY o.id`;
  const { rows } = await db.query(q, [order_id]);
  return rows[0];
}

module.exports = {
  createCustomer,
  createOrder,
  updateOrderStatus,
  addOrderItem,
  getOrderWithItems
};
