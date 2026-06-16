SELECT order_id, customer_id, amount
FROM orders
WHERE status = 'active'
