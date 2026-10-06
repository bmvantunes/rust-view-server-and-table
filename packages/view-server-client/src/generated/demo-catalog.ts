// Topic aliases share the single proto-authored Orders schema.
import {catalog as generated} from './topics.ts';
export const catalog={client_orders:generated.orders,server_orders:generated.orders} as const;
