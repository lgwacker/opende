with src as (
    select * from {{ ref('raw_orders') }}
)
select order_id, customer_id, amount
from src
