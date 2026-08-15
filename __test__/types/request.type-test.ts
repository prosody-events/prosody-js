import { ProsodyClient, type Outcome, type ResponseError } from "../../index";

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
      headers: { tenant: "acme" },
    },
  );
  assertTrue<
    Equal<typeof results, ReadonlyMap<string, Outcome<{ total: number }>>>
  >();

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
  onTimer: async () => ({ accepted: false }),
});

client.subscribe({
  // @ts-expect-error Date is not a JSON response.
  onMessage: () => new Date(),
  onExcise: () => null,
});

void request;
