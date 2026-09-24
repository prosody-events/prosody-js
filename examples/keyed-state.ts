import {
  ProsodyClient,
  map,
  messageDeque,
  set,
  value,
  type EventHandler,
} from "../index";

interface OrderEvent {
  orderId: string;
  total: number;
}

interface Cart {
  items: string[];
}

const CART = value<Cart>("cart", { ttlSeconds: 30 * 24 * 60 * 60 });
const TOTALS = map<number>("totals");
const BACKLOG = messageDeque<OrderEvent>("backlog", { capacity: 100 });
const SEEN = set("seen-orders");

const handler = {
  async onExcise(context, message) {
    console.info(`excise ${message.key}`);
    await context.state(CART).clear();
    await context.state(TOTALS).clear();
    await context.state(BACKLOG).clear();
    await context.state(SEEN).clear();
    return null;
  },

  async onMessage(context, message) {
    const seen = context.state(SEEN);
    if (await seen.has(message.payload.orderId)) return null;
    await seen.add(message.payload.orderId);

    const cart = context.state(CART);
    const current = (await cart.get()) ?? { items: [] };
    await cart.set({
      items: [...current.items, message.payload.orderId],
    });

    const totals = context.state(TOTALS);
    await totals.set(message.key, message.payload.total);
    for await (const [key, total] of totals.entries({ limit: 10 })) {
      console.info(`${key}=${total.toFixed(2)}`);
    }

    const backlog = context.state(BACKLOG);
    await backlog.push(message);
    const oldest = await backlog.at(0);
    if (oldest !== null) {
      console.info(`oldest order: ${oldest.payload.orderId}`);
    }
    return null;
  },

  async onTimer() {},
} satisfies EventHandler<OrderEvent>;

async function main(): Promise<void> {
  const client = await ProsodyClient.create({
    mock: true,
    groupId: "keyed-state-example",
    subscribedTopics: "orders",
    stateCollections: [CART, TOTALS, BACKLOG, SEEN],
  });

  await client.subscribe(handler);
  await client.shutdown();
}

void main();
