const { Space, BodyAdapter, Brain, Translator, Aggregator, PRIORITY } = require("./packages/core");
const { OllamaBrain } = require("./packages/bridges/ollama");

module.exports = {
  Space,
  BodyAdapter,
  PRIORITY,
  Brain,
  Translator,
  Aggregator,
  OllamaBrain,
};
