const {
  Space,
  BodyAdapter,
  SCPBody,
  NetworkBodyAdapter,
  PRIORITY,
  Brain,
  Translator,
  Aggregator,
} = require("./packages/core");
const { OllamaBrain } = require("./packages/bridges/ollama");
const { attachIntrospection } = require("./packages/core/introspection");

module.exports = {
  Space,
  BodyAdapter,
  SCPBody,
  NetworkBodyAdapter,
  PRIORITY,
  Brain,
  Translator,
  Aggregator,
  OllamaBrain,
  attachIntrospection,
};
