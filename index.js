const {
  Space,
  BodyAdapter,
  SCPBody,
  NetworkBodyAdapter,
  PRIORITY,
  Brain,
  Translator,
  Aggregator,
  VerticalMemory,
} = require("./packages/core");
const { OllamaBrain } = require("./packages/bridges/ollama");
const { BedrockBrain } = require("./packages/bridges/bedrock");
const { AnthropicBrain } = require("./packages/bridges/anthropic");
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
  VerticalMemory,
  OllamaBrain,
  BedrockBrain,
  AnthropicBrain,
  attachIntrospection,
};
