import {
  ProsodyClient,
  type ErrorCategory,
  type RequestResult,
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
    ["billing"],
    2_000,
    { headers: { tenant: "acme" } },
  );
  assertTrue<
    Equal<(typeof results)[number], RequestResult<{ total: number }>>
  >();

  const result = results[0];
  if (result?.ok) {
    assertTrue<Equal<typeof result.value, { total: number }>>();
  } else if (result?.error.kind === "handler") {
    assertTrue<Equal<typeof result.error.category, ErrorCategory>>();
    assertTrue<Equal<typeof result.error.message, string>>();
  }
}

void request;
