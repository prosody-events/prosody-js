import {
  AdminClient,
  ConsumerState,
  Mode,
  ProsodyClient,
  type JsonValue,
  type Outcome,
  type ResponseError,
} from "../../index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
declare function assertTrue<T extends true>(): void;

declare const client: ProsodyClient;

async function request(): Promise<void> {
  const results = await client.request<{ total: number }>(
    "orders",
    "order-1",
    { type: "order.created" },
    {
      subsystems: ["billing"],
      timeoutMs: 2_000,
    },
  );
  const exciseResults = await client.requestExcise<{ total: number }>(
    "orders",
    "order-1",
    { subsystems: ["billing"], timeoutMs: 2_000 },
  );
  assertTrue<
    Equal<typeof exciseResults, ReadonlyMap<string, Outcome<{ total: number }>>>
  >();
  assertTrue<
    Equal<typeof results, ReadonlyMap<string, Outcome<{ total: number }>>>
  >();

  // An interface payload has no index signature. The payload type is
  // inferred, so the interface passes as it does for send().
  interface OrderCreated {
    type: string;
    id: string;
  }
  const order: OrderCreated = { type: "order.created", id: "order-1" };
  await client.send("orders", "order-1", order);
  const inferred = await client.request("orders", "order-1", order, {
    subsystems: ["billing"],
    timeoutMs: 2_000,
  });
  assertTrue<Equal<typeof inferred, ReadonlyMap<string, Outcome<JsonValue>>>>();
  await client.request<{ total: number }, OrderCreated>(
    "orders",
    "order-1",
    order,
    { subsystems: ["billing"], timeoutMs: 2_000 },
  );
  await client.request(
    "orders",
    "order-1",
    // @ts-expect-error Date is not a JSON payload.
    { at: new Date() },
    { subsystems: ["billing"], timeoutMs: 2_000 },
  );

  const outcome = results.get("billing");
  if (outcome?.ok) {
    assertTrue<Equal<typeof outcome.value, { total: number }>>();
  } else if (outcome) {
    assertTrue<Equal<typeof outcome.error, ResponseError>>();
  }
}

client.subscribe<{ id: string }, { accepted: boolean }>({
  onMessage: () => ({ accepted: true }),
  onExcise: () => ({ accepted: true }),
  onTimer: async () => {},
});

client.subscribe({
  // @ts-expect-error Date is not a JSON response.
  onMessage: () => new Date(),
  onExcise: () => null,
});

// @ts-expect-error Every handler method is required.
client.subscribe({ onMessage: () => null, onExcise: () => null });

client.subscribe({
  // @ts-expect-error undefined is not a JSON response.
  onMessage: () => undefined,
  onExcise: () => null,
});

// The runtime enums and the admin client are values, not only types.
export async function values(): Promise<void> {
  const client = await ProsodyClient.create({ mode: Mode.Pipeline });
  const running: boolean =
    (await client.consumerState()) === ConsumerState.Running;
  void running;
  const admin = new AdminClient("localhost:9094");
  await admin.createTopic("orders", 1, 1, { cleanupPolicy: "compact" });
}

void request;
