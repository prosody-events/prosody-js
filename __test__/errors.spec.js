const {
  PermanentError,
  PermanentStateError,
  TransientError,
  permanent,
  transient,
} = require("../index.js");

describe("error decorators", () => {
  class ValidationError extends Error {}

  class Handler {
    @permanent(ValidationError)
    rejects(error) {
      return Promise.reject(error);
    }

    @permanent(ValidationError)
    async rejectsAsync(error) {
      throw error;
    }

    @transient(ValidationError)
    throws(error) {
      throw error;
    }

    @permanent(ValidationError)
    returns(value) {
      return value;
    }
  }

  // A plain method that returns a promise gets the same classification as a
  // native async method, because a transpiler can produce either one.
  it.each(["rejects", "rejectsAsync"])(
    "%s wraps a matching rejection and keeps its cause",
    async (method) => {
      const cause = new ValidationError("bad order");
      const rejection = new Handler()[method](cause);
      await expect(rejection).rejects.toBeInstanceOf(PermanentError);
      await expect(rejection).rejects.toMatchObject({
        message: "bad order",
        cause,
      });
    },
  );

  it("wraps a matching synchronous throw", () => {
    const cause = new ValidationError("bad order");
    let caught;
    try {
      new Handler().throws(cause);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransientError);
    expect(caught.cause).toBe(cause);
  });

  it("passes other errors and plain results through", async () => {
    const other = new TypeError("other");
    await expect(new Handler().rejects(other)).rejects.toBe(other);
    expect(new Handler().returns(7)).toBe(7);
  });

  it("rejects a class field at class definition", () => {
    expect(() => {
      class Fielded {
        @permanent(ValidationError) onMessage = () => null;
      }
      return Fielded;
    }).toThrow(TypeError);
  });

  it("error classes keep the standard cause option", () => {
    const cause = new Error("root");
    expect(new PermanentError("x", { cause }).cause).toBe(cause);
    expect(new PermanentStateError("x", { cause }).cause).toBe(cause);
  });
});
