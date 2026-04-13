const { Space, BodyAdapter, Brain, Translator, Aggregator } = require("./packages/core");
const { OllamaBrain } = require("./packages/bridges/ollama");

module.exports = {
  // Core
  Space,
  BodyAdapter,
  Brain,
  Translator,
  Aggregator,
  // Bridges
  OllamaBrain,
};
