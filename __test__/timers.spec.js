const { EventEmitter } = require("events");
const { MESSAGE_TIMEOUT, liveSuite, waitForEvent } = require("./support");

describe("ProsodyClient", () => {
  const env = liveSuite();
  const {
    createTimerTestSetup,
    createBasicTimerHandler,
    sendTestMessage,
    expectTimerApproximatelyEqual,
  } = env;

  it("schedules and fires timers at correct time", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let scheduledTime;

    const TimerHandler = createBasicTimerHandler(
      testEvents,
      async (context, message) => {
        scheduledTime = new Date(Date.now() + timerDelayMs);
        await context.schedule(scheduledTime);
        testEvents.emit("timerScheduled", scheduledTime);
      },
    );

    await env.client.subscribe(new TimerHandler());
    const testMessage = await sendTestMessage();

    await waitForEvent(testEvents, "messageReceived", MESSAGE_TIMEOUT);
    await waitForEvent(testEvents, "timerScheduled", MESSAGE_TIMEOUT);

    expect(scheduledTime).toBeDefined();

    const [timerResult] = await waitForEvent(
      testEvents,
      "timerFired",
      timerDelayMs + 5000,
    );
    const { timer, actualTime } = timerResult;

    expect(timer.key).toBe(testMessage.key);
    expectTimerApproximatelyEqual(timer.time, scheduledTime);
    expectTimerApproximatelyEqual(actualTime, scheduledTime);
  });

  it("clears and reschedules timers correctly", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let firstScheduledTime;
    let secondScheduledTime;
    let timerCount = 0;

    const TimerHandler = createBasicTimerHandler(
      testEvents,
      async (context, message) => {
        // Schedule first timer (4 seconds from now)
        firstScheduledTime = new Date(Date.now() + timerDelayMs * 2);
        await context.schedule(firstScheduledTime);
        testEvents.emit("firstTimerScheduled");

        // Clear and schedule a new timer (2 seconds from now - sooner)
        secondScheduledTime = new Date(Date.now() + timerDelayMs);
        await context.clearAndSchedule(secondScheduledTime);
        testEvents.emit("secondTimerScheduled");
      },
      async (context, timer) => {
        timerCount++;
        testEvents.emit("timerFired", { timer, timerCount });
      },
    );

    await env.client.subscribe(new TimerHandler());
    await sendTestMessage();

    await waitForEvent(testEvents, "firstTimerScheduled", MESSAGE_TIMEOUT);
    await waitForEvent(testEvents, "secondTimerScheduled", MESSAGE_TIMEOUT);

    // Wait for timer to fire - only the second one should fire
    const [timerResult] = await waitForEvent(
      testEvents,
      "timerFired",
      timerDelayMs + 5000,
    );
    const { timer } = timerResult;

    expect(timerCount).toBe(1); // Only one timer should have fired
    expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
  });

  it("unschedules specific timers", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let firstScheduledTime;
    let secondScheduledTime;
    let timerCount = 0;

    // Use different keys to avoid upsert behavior, and ensure full second separation
    const TimerHandler = createBasicTimerHandler(
      testEvents,
      async (context, message) => {
        // Schedule two timers with different times (2 and 4 seconds from now)
        firstScheduledTime = new Date(Date.now() + timerDelayMs); // 2 seconds
        secondScheduledTime = new Date(Date.now() + timerDelayMs * 2); // 4 seconds

        await context.schedule(firstScheduledTime);
        await context.schedule(secondScheduledTime);
        testEvents.emit("timersScheduled");

        // Unschedule the first timer
        await context.unschedule(firstScheduledTime);
        testEvents.emit("firstTimerUnscheduled");
      },
      async (context, timer) => {
        timerCount++;
        testEvents.emit("timerFired", { timer, timerCount });
      },
    );

    await env.client.subscribe(new TimerHandler());
    await sendTestMessage();

    await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
    await waitForEvent(testEvents, "firstTimerUnscheduled", MESSAGE_TIMEOUT);

    // Wait for remaining timer to fire (should be the second one)
    const maxWaitTime = timerDelayMs * 2 + 5000;
    const [timerResult] = await waitForEvent(
      testEvents,
      "timerFired",
      maxWaitTime,
    );
    const { timer } = timerResult;

    expect(timerCount).toBe(1); // Only second timer should fire
    expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
  });

  it("clears all scheduled timers", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let timerCount = 0;

    const TimerHandler = createBasicTimerHandler(
      testEvents,
      async (context, message) => {
        // Schedule multiple timers with full second separation
        // Each timer is for a different second, so all would normally be kept
        // But we'll clear them all to test clearScheduled()
        const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
        const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
        const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

        await context.schedule(time1);
        await context.schedule(time2);
        await context.schedule(time3);
        testEvents.emit("timersScheduled");

        // Clear all timers
        await context.clearScheduled();
        testEvents.emit("allTimersCleared");
      },
      async (context, timer) => {
        timerCount++;
        testEvents.emit("timerFired");
      },
    );

    await env.client.subscribe(new TimerHandler());
    await sendTestMessage();

    await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
    await waitForEvent(testEvents, "allTimersCleared", MESSAGE_TIMEOUT);

    // Wait longer than all timers would have fired
    await new Promise((resolve) => setTimeout(resolve, timerDelayMs + 3000));

    expect(timerCount).toBe(0); // No timers should have fired
  });

  it("retrieves scheduled timer times", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let scheduledTimes;

    const TimerHandler = createBasicTimerHandler(
      testEvents,
      async (context, message) => {
        // Schedule multiple timers with full second separation
        // Since each timer is for a different second, all should be kept
        // (timers are keyed by message key + time rounded to seconds)
        const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
        const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
        const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

        await context.schedule(time1);
        await context.schedule(time2);
        await context.schedule(time3);

        // Get scheduled times
        scheduledTimes = await context.scheduled();
        testEvents.emit("scheduledRetrieved", {
          scheduledTimes,
          expectedTimes: [time1, time2, time3],
        });
      },
    );

    await env.client.subscribe(new TimerHandler());
    await sendTestMessage();

    const [retrievalResult] = await waitForEvent(
      testEvents,
      "scheduledRetrieved",
      MESSAGE_TIMEOUT,
    );
    const { scheduledTimes: retrievedTimes, expectedTimes } = retrievalResult;

    // All scheduled timers should be returned
    expect(retrievedTimes).toHaveLength(3);

    // Sort both arrays for comparison (scheduled() might return in different order)
    const sortedRetrieved = retrievedTimes.sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    const sortedExpected = expectedTimes.sort(
      (a, b) => a.getTime() - b.getTime(),
    );

    sortedExpected.forEach((expectedTime, index) => {
      expectTimerApproximatelyEqual(sortedRetrieved[index], expectedTime);
    });
  });

  it("resolves onCancel for each message (no promise accumulation)", async () => {
    const testEvents = new EventEmitter();
    let onCancelCount = 0;
    let messageCount = 0;
    const numMessages = 5;

    await env.client.subscribe({
      onMessage: async (context, message, signal) => {
        messageCount++;

        // Track when onCancel resolves for this message
        context.onCancel().then(() => {
          onCancelCount++;
          if (onCancelCount === numMessages) {
            testEvents.emit("allCancelsResolved");
          }
        });

        // Complete handler normally
        env.messageStream.push(message);
        if (messageCount === numMessages) {
          testEvents.emit("allMessagesProcessed");
        }
      },
    });

    // Send multiple messages
    for (let i = 0; i < numMessages; i++) {
      await env.client.send(env.topic, `key-${i}`, {
        content: `Message ${i}`,
      });
    }

    // Wait for all messages to be processed
    await waitForEvent(testEvents, "allMessagesProcessed", MESSAGE_TIMEOUT);

    // Give time for onCancel promises to resolve
    await waitForEvent(testEvents, "allCancelsResolved", MESSAGE_TIMEOUT);

    // All onCancel promises should have resolved (one per message)
    expect(onCancelCount).toBe(numMessages);
  });

  it("demonstrates upsert behavior for timers at same time", async () => {
    const { testEvents, timerDelayMs } = createTimerTestSetup();
    let scheduledTimes;
    let timerCount = 0;

    class TimerHandler {
      async onMessage(context, message) {
        testEvents.emit("messageReceived", { context, message });

        // Schedule multiple timers at the exact same time (same second)
        // Due to upsert behavior (one timer per key per second), only one should remain
        const sameTime = new Date(Date.now() + timerDelayMs);

        await context.schedule(sameTime);
        await context.schedule(sameTime); // This should replace the first one
        await context.schedule(sameTime); // This should replace the second one

        // Get scheduled times to verify only one remains
        scheduledTimes = await context.scheduled();
        testEvents.emit("scheduledRetrieved", {
          scheduledTimes,
          expectedTime: sameTime,
        });
      }

      async onTimer(context, timer) {
        timerCount++;
        testEvents.emit("timerFired", { timer, timerCount });
      }
    }

    await env.client.subscribe(new TimerHandler());
    await sendTestMessage();

    const [retrievalResult] = await waitForEvent(
      testEvents,
      "scheduledRetrieved",
      MESSAGE_TIMEOUT,
    );
    const { scheduledTimes: retrievedTimes, expectedTime } = retrievalResult;

    // Due to upsert behavior, only one timer should remain
    expect(retrievedTimes).toHaveLength(1);
    expectTimerApproximatelyEqual(retrievedTimes[0], expectedTime);

    // Wait for the timer to fire
    const [timerResult] = await waitForEvent(
      testEvents,
      "timerFired",
      timerDelayMs + 5000,
    );

    // Only one timer should have fired due to upsert behavior
    expect(timerResult.timerCount).toBe(1);
  });
});
