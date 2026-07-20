// jest.config.js
module.exports = {
  // Runtime tests live under __test__; generated native artifacts can be very large.
  roots: ["<rootDir>/__test__"],

  // Set timeout for tests (in milliseconds)
  testTimeout: 180000,

  // Maximum number of workers used to run your tests
  maxWorkers: "90%",

  // Transform files with Babel
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        presets: [["@babel/preset-env", { targets: { node: "current" } }]],
        plugins: [
          ["@babel/plugin-proposal-decorators", { version: "2023-05" }],
        ],
      },
    ],
  },
};
