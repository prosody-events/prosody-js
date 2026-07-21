import {
  ProsodyClient,
  type EventHandler,
  type JsonValue,
  type Message,
} from "../../index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
declare function assertTrue<T extends true>(): void;

interface OrderPayload {
  orderId: string;
  total: number;
  tags: string[];
}

const orderHandler = {
  async onMessage(_context, message, _signal) {
    assertTrue<Equal<typeof message, Message<OrderPayload>>>();
    const orderId: string = message.payload.orderId;
    const total: number = message.payload.total;
    void orderId;
    void total;

    // @ts-expect-error OrderPayload has no customerId field
    void message.payload.customerId;
    // @ts-expect-error total is a number, not a string
    const badTotal: string = message.payload.total;
    void badTotal;
  },
} satisfies EventHandler<OrderPayload>;

const defaultHandler = {
  async onMessage(_context, message, _signal) {
    assertTrue<Equal<typeof message.payload, JsonValue>>();
    // @ts-expect-error a generic JSON value has no known object fields
    void message.payload.orderId;
  },
} satisfies EventHandler;

declare const client: ProsodyClient;
client.subscribe(orderHandler);
client.subscribe(defaultHandler);
client.subscribe<OrderPayload>({
  async onMessage(_context, message, _signal) {
    assertTrue<Equal<typeof message.payload, OrderPayload>>();
  },
});

client.send("orders", "1", {
  orderId: "order-1",
  total: 42,
  tags: ["priority"],
});
client.send("orders", "2", [true, null, { nested: "value" }]);
const typedPayload: OrderPayload = {
  orderId: "order-typed",
  total: 7,
  tags: ["typed-interface"],
};
client.send("orders", "typed", typedPayload);
client.send("orders", "readonly", [1, { nested: true }] as const);

// @ts-expect-error functions are not JSON values
client.send("orders", "3", () => "not JSON");
// @ts-expect-error undefined is not a JSON value
client.send("orders", "4", undefined);
// @ts-expect-error Date instances are not JSON values; serialize explicitly
client.send("orders", "5", new Date());
// @ts-expect-error nested undefined is not a JSON value
client.send("orders", "6", { invalid: undefined });
