// jest.config.js
module.exports = {
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
