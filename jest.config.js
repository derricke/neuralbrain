const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  // Many suites load the real in-process ONNX embedder (nomic via
  // @huggingface/transformers); the slowest test measured ~32 s under parallel
  // workers, far past Jest's 5 s default. 120 s leaves ~4x headroom.
  testTimeout: 120000,
  transform: {
    ...tsJestTransformCfg,
  },
};