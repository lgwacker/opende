with src as (
    select * from raw_orders
)
select order_id, customer_id, amount
from src
