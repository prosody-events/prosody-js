const { EventEmitter } = require("events");
const { ConsumerState, ProsodyClient } = require("../index.js");
const {
  MESSAGE_TIMEOUT,
  SOURCE_NAME,
  liveSuite,
  waitForEvent,
  waitForMessages,
} = require("./support");

describe("ProsodyClient", () => {
  const env = liveSuite();

  it("initializes correctly", async () => {
    expect(env.client).toBeInstanceOf(ProsodyClient);
    expect(await env.client.consumerState()).toBe(ConsumerState.Configured);
  });

  it("exposes source system identifier", async () => {
    expect(env.client.sourceSystem).toBe(SOURCE_NAME);
    expect(typeof env.client.sourceSystem).toBe("string");
  });

  it("subscribes and unsubscribes", async () => {
    await env.client.subscribe({
      onMessage: (_, message) => {
        env.messageStream.push(message);
      },
    });
    expect(await env.client.consumerState()).toBe(ConsumerState.Running);

    await env.client.unsubscribe();
    expect(await env.client.consumerState()).toBe(ConsumerState.Configured);
  });

  it("sends and receives a message", async () => {
    await env.client.subscribe({
      onMessage: (_, message) => {
        env.messageStream.push(message);
      },
    });

    const testMessage = {
      key: "test-key",
      payload: { content: "Hello, Kafka!" },
    };

    await env.client.send(env.topic, testMessage.key, testMessage.payload);

    const [receivedMessage] = await waitForMessages(
      env.messageStream,
      1,
      MESSAGE_TIMEOUT,
    );

    expect(receivedMessage.topic).toBe(env.topic);
    expect(receivedMessage.key).toBe(testMessage.key);
    expect(receivedMessage.payload).toEqual(testMessage.payload);
  });

  // Every record reports the producer's source system, and only a request
  // asks for a response.
  it("reports sourceSystem and responseRequested on each record", async () => {
    const observe = (kind) => (_, record) => {
      env.messageStream.push({
        kind,
        key: record.key,
        sourceSystem: record.sourceSystem,
        responseRequested: record.responseRequested,
      });
      return null;
    };
    await env.client.subscribe({
      onMessage: observe("message"),
      onExcise: observe("excise"),
    });

    const options = { subsystems: ["inventory"], timeoutMs: MESSAGE_TIMEOUT };
    await env.client.send(env.topic, "sent", { type: "order.created" });
    await env.client.excise(env.topic, "excised");
    await env.client.request(
      env.topic,
      "asked",
      { type: "order.created" },
      options,
    );
    await env.client.requestExcise(env.topic, "asked-excise", options);
    const records = await waitForMessages(
      env.messageStream,
      4,
      MESSAGE_TIMEOUT,
    );

    expect(records.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      {
        kind: "message",
        key: "asked",
        sourceSystem: SOURCE_NAME,
        responseRequested: true,
      },
      {
        kind: "excise",
        key: "asked-excise",
        sourceSystem: SOURCE_NAME,
        responseRequested: true,
      },
      {
        kind: "excise",
        key: "excised",
        sourceSystem: SOURCE_NAME,
        responseRequested: false,
      },
      {
        kind: "message",
        key: "sent",
        sourceSystem: SOURCE_NAME,
        responseRequested: false,
      },
    ]);
  });

  it("sends and receives an excise record", async () => {
    await env.client.subscribe({
      onExcise: async (_, message) => env.messageStream.push(message),
    });

    await env.client.excise(env.topic, "obsolete-key");
    const [message] = await waitForMessages(
      env.messageStream,
      1,
      MESSAGE_TIMEOUT,
    );

    expect(message.key).toBe("obsolete-key");
    expect("payload" in message).toBe(false);
  });

  it("handles multiple messages with correct ordering", async () => {
    await env.client.subscribe({
      onMessage: (_, message) => {
        env.messageStream.push(message);
      },
    });

    const messagesToSend = [
      { key: "key1", payload: { content: "Message 1", sequence: 1 } },
      { key: "key2", payload: { content: "Message 2", sequence: 1 } },
      { key: "key1", payload: { content: "Message 3", sequence: 2 } },
      { key: "key3", payload: { content: "Message 4", sequence: 1 } },
      { key: "key2", payload: { content: "Message 5", sequence: 2 } },
    ];

    for (const msg of messagesToSend) {
      await env.client.send(env.topic, msg.key, msg.payload);
    }

    const receivedMessages = await waitForMessages(
      env.messageStream,
      messagesToSend.length,
      MESSAGE_TIMEOUT,
    );

    expect(receivedMessages).toHaveLength(messagesToSend.length);

    const groupMessagesByKey = (messages) =>
      messages.reduce((acc, msg) => {
        if (!acc[msg.key]) acc[msg.key] = [];
        acc[msg.key].push(msg);
        return acc;
      }, {});

    const sentMessagesByKey = groupMessagesByKey(messagesToSend);
    const receivedMessagesByKey = groupMessagesByKey(receivedMessages);

    expect(Object.keys(sentMessagesByKey)).toEqual(
      expect.arrayContaining(Object.keys(receivedMessagesByKey)),
    );

    Object.keys(sentMessagesByKey).forEach((key) => {
      const sentMessages = sentMessagesByKey[key];
      const receivedMessages = receivedMessagesByKey[key];

      expect(receivedMessages).toHaveLength(sentMessages.length);

      sentMessages.forEach((sent, index) => {
        expect(receivedMessages[index].payload).toEqual(sent.payload);
      });
    });

    Object.values(receivedMessagesByKey).forEach((messages) => {
      const sequences = messages.map((msg) => msg.payload.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    });

    receivedMessages.forEach((msg) => {
      expect(msg.topic).toBe(env.topic);
    });
  });

  it("supports abort controller in onMessage handler", async () => {
    const testEvents = new EventEmitter();
    let messageAborted = false;

    await env.client.subscribe({
      onMessage: (context, message, signal) => {
        const result = new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              messageAborted = true;
              testEvents.emit("processingAborted", message);
              resolve();
            },
            { once: true },
          );
        });

        testEvents.emit("processingStarted", message);
        return result;
      },
    });

    await env.client.send(env.topic, "hanging-key", {
      content: "I will hang until aborted",
    });

    await waitForEvent(testEvents, "processingStarted", MESSAGE_TIMEOUT);
    const unsubscribePromise = env.client.unsubscribe();
    await waitForEvent(testEvents, "processingAborted", MESSAGE_TIMEOUT);
    await unsubscribePromise;

    expect(messageAborted).toBe(true);
    expect(await env.client.consumerState()).toBe(ConsumerState.Configured);
  });

  it("preserves non-Error abort reasons when send rejects", async () => {
    const controller = new AbortController();
    controller.abort("timer cancelled");

    await expect(
      env.client.send(
        env.topic,
        "aborted-key",
        { content: "ignored" },
        controller.signal,
      ),
    ).rejects.toEqual(expect.objectContaining({ message: "timer cancelled" }));
  });
});
