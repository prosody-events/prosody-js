import { value, messageDeque, type EventHandler, type Message } from "../index";

interface Activity {
  actor: string;
  action: string;
}

// Your own delivery function (push, email, …) — the only thing here you write.
declare function notify(
  userId: string,
  activities: Message<Activity>[],
): Promise<void>;

// Declare the collections once, at module scope; register both on the client
// via `stateCollections: [WINDOW, PENDING]`.
const WINDOW = value<boolean>("window"); // is a batch open for this user?
const PENDING = messageDeque<Activity>("pending", { capacity: 100 }); // keep the latest 100 messages

const handler = {
  async onMessage(context, message) {
    // message.key = userId; message.payload = { actor, action }
    const window = context.state(WINDOW); // bind THIS user's handles for THIS event
    const pending = context.state(PENDING);
    if (!(await window.get())) {
      // no batch open → this is the first event: send it right away
      await notify(message.key, [message]);
      await window.set(true);
      // clearAndSchedule (not schedule): timers are NOT rolled back with state,
      // so a retried event must not stack a second timer — this keeps exactly one.
      await context.clearAndSchedule(new Date(Date.now() + 5 * 60_000));
    } else {
      await pending.push(message); // a batch is open → just save the message
    }
  },

  async onTimer(context, timer) {
    // fires ~5 minutes later, for timer.key
    const window = context.state(WINDOW);
    const pending = context.state(PENDING);
    const batch: Message<Activity>[] = [];
    for await (const msg of pending.values()) {
      batch.push(msg); // the scan resolves the saved messages concurrently
    }
    if (batch.length > 0) {
      await notify(timer.key, batch); // one summary of the actual saved messages
    }
    await pending.clear(); // empty the buffer
    await window.clear(); // close the batch; the next event opens a fresh one
  },
} satisfies EventHandler<Activity>;

void handler;
