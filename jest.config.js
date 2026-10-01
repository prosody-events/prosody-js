// jest.config.js
module.exports = {
  // Runtime tests live under __test__; generated native artifacts can be very large.
  roots: ["<rootDir>/__test__"],

  // Set timeout for tests (in milliseconds)
  testTimeout: 180000,

  // The live suites share one Kafka broker and one Cassandra keyspace. Run
  // the test files one at a time so that they do not compete for them.
  maxWorkers: 1,

  // Transform files with Babel
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        presets: [["@babel/preset-env", { targets: { node: "current" } }]],
        plugins: [
          ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
        ],
      },
    ],
  },
};
