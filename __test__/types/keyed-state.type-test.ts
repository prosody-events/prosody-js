/**
 * Compile-time contract for the typed keyed-state surface. Run by
 * `npm run typecheck`; never executed. `Equal<>` asserts EXACT types, so a
 * silent degradation to `any` fails the gate (bare assignability would not).
 */
import {
  Configuration,
  Context,
  DequeState,
  JsonValue,
  MapState,
  Message,
  PermanentStateError,
  TransientStateError,
  ValueState,
  deque,
  isStateError,
  map,
  messageDeque,
  messageMap,
  messageValue,
  value,
} from "../../index";

interface Cart {
  items: string[];
}
interface OrderEvent {
  orderId: string;
  total: number;
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
declare function assertTrue<T extends true>(): void;

const cart = value<Cart>("cart", { ttlSeconds: 30 * 86400 });
const totals = map<number>("totals", { keysetLimit: 256 });
const tags = deque<string>("tags", { readUncommitted: true });
const lastOrder = messageValue<OrderEvent>("last-order");
const orderIndex = messageMap<OrderEvent>("order-index");
const backlog = messageDeque<OrderEvent>("backlog");
const defaultJson = value("default-json");

// The SAME definition objects serialize into the client configuration.
const config: Configuration = {
  stateCollections: [cart, totals, tags, lastOrder, orderIndex, backlog],
};
void config;

declare const context: Context;
declare const incoming: Message<OrderEvent>;

export async function checks(): Promise<void> {
  // ---- overload resolution returns the exact handle types ----
  const c = context.state(cart);
  assertTrue<Equal<typeof c, ValueState<Cart>>>();
  const t = context.state(totals);
  assertTrue<Equal<typeof t, MapState<number>>>();
  const d = context.state(tags);
  assertTrue<Equal<typeof d, DequeState<string>>>();
  const lv = context.state(lastOrder);
  assertTrue<Equal<typeof lv, ValueState<Message<OrderEvent>>>>();
  const om = context.state(orderIndex);
  assertTrue<Equal<typeof om, MapState<Message<OrderEvent>>>>();
  const b = context.state(backlog);
  assertTrue<Equal<typeof b, DequeState<Message<OrderEvent>>>>();
  const defaultState = context.state(defaultJson);
  assertTrue<Equal<typeof defaultState, ValueState<JsonValue>>>();

  // ---- value ----
  const current: Cart | null = await c.get();
  assertTrue<Equal<Awaited<ReturnType<typeof c.get>>, Cart | null>>();
  await c.set({ items: [...(current?.items ?? []), incoming.payload.orderId] });
  await c.clear();

  // ---- map ----
  await t.set(incoming.key, incoming.payload.total);
  const many = await t.getMany([incoming.key, "other"]);
  assertTrue<Equal<typeof many, (number | null)[]>>();
  assertTrue<Equal<Awaited<ReturnType<typeof t.has>>, boolean>>();
  await t.delete(incoming.key);
  for await (const [key, total] of t.entries("backward")) {
    assertTrue<Equal<typeof key, string>>();
    assertTrue<Equal<typeof total, number>>();
  }
  for await (const entry of t) {
    assertTrue<Equal<typeof entry, [string, number]>>();
  }
  // keys()/values() take the same optional direction as entries().
  for await (const key of t.keys("backward")) {
    assertTrue<Equal<typeof key, string>>();
  }
  for await (const v of t.values("backward")) {
    assertTrue<Equal<typeof v, number>>();
  }

  // ---- deque ----
  await d.push("a");
  await d.unshift("z");
  const popped: string | null = await d.pop();
  void popped;
  const shifted: string | null = await d.shift();
  void shifted;
  assertTrue<Equal<Awaited<ReturnType<typeof d.length>>, number>>();
  assertTrue<Equal<Awaited<ReturnType<typeof d.isEmpty>>, boolean>>();
  await d.clear();
  const front: string | null = await d.at(0);
  const back: string | null = await d.at(-1);
  void front;
  void back;
  assertTrue<Equal<Awaited<ReturnType<typeof d.at>>, string | null>>();
  for await (const item of d.values("backward")) {
    assertTrue<Equal<typeof item, string>>();
  }

  // ---- deque capacity (bounded backlog) is a deque-only option ----
  const bounded = deque<string>("bd", { capacity: 100 });
  const messageBounded = messageDeque<OrderEvent>("mbd", { capacity: 50 });
  // The frozen definitions expose an optional readonly capacity.
  assertTrue<Equal<typeof bounded.capacity, number | undefined>>();
  assertTrue<Equal<typeof messageBounded.capacity, number | undefined>>();
  void bounded;
  void messageBounded;

  // ---- message collections carry Message<P> ----
  const oldest = await b.at(0);
  assertTrue<Equal<typeof oldest, Message<OrderEvent> | null>>();
  if (oldest !== null) {
    const orderId: string = oldest.payload.orderId;
    void orderId;
  }
  await b.push(incoming);
  await lv.set(incoming);
  await om.set("latest", incoming);

  // ---- commit/rollback are void (owner directive: no "applied"/"noop") ----
  assertTrue<Equal<Awaited<ReturnType<typeof c.commit>>, void>>();
  assertTrue<Equal<Awaited<ReturnType<typeof c.rollback>>, void>>();

  // ---- unparameterized Message retains the safe JSON default ----
  const defaultMessage = null as unknown as Message;
  assertTrue<Equal<typeof defaultMessage.payload, JsonValue>>();

  // ---- errors ----
  const err: unknown = new PermanentStateError("boom");
  if (isStateError(err)) {
    assertTrue<Equal<typeof err.isPermanent, boolean>>();
  }
  const te = new TransientStateError("later");
  assertTrue<Equal<typeof te.isPermanent, false>>();

  // ---- negatives (self-falsifying: TS2578 if the error ever disappears) ----
  // @ts-expect-error a Cart field cannot hold a number
  await c.set({ items: 42 });
  // @ts-expect-error map keys are strings only
  await t.get(42);
  // @ts-expect-error map values are numbers in this collection
  await t.set("k", "not-a-number");
  // @ts-expect-error direction is a closed "forward" | "backward" set
  d.values("sideways");
  // @ts-expect-error the same closed set applies to map keys()
  t.keys("sideways");
  // @ts-expect-error a message deque stores Message<P>, not the bare payload
  await b.push(incoming.payload);
  // @ts-expect-error keysetLimit is map-only (value options reject it)
  value<Cart>("v2", { keysetLimit: 5 });
  // @ts-expect-error keysetLimit is map-only (deque options reject it)
  deque<string>("d2", { keysetLimit: 5 });
  // @ts-expect-error capacity is deque-only (value options reject it)
  value<Cart>("v3", { capacity: 5 });
  // @ts-expect-error capacity is deque-only (map options reject it)
  map<number>("m3", { capacity: 5 });

  // ---- handles are vended by context.state(), never constructed directly ----
  // @ts-expect-error ValueState has a private constructor
  new ValueState();
  // @ts-expect-error MapState has a private constructor
  new MapState();
  // @ts-expect-error DequeState has a private constructor
  new DequeState();

  // ---- a top-level null write is a compile error (null is not storable) ----
  const nv = value<string | null>("nv");
  // @ts-expect-error top-level null is not a storable value
  await context.state(nv).set(null);
  const nm = map<number | null>("nm");
  // @ts-expect-error top-level null is not a storable map value
  await context.state(nm).set("k", null);
  const nd = deque<string | null>("nd");
  // @ts-expect-error top-level null is not a storable deque element
  await context.state(nd).push(null);
  // nested null IS permitted — only the top-level value is banned.
  const nested = value<{ x: string | null }>("nested");
  await context.state(nested).set({ x: null });
}
