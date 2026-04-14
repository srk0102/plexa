// Template inprocess body for Plexa.
// Pure JavaScript class. Zero ports. Zero HTTP. Zero transport configuration.
// Plexa imports it and calls its methods directly.
//
// Use this as the starting point for any new JS body.

const { BodyAdapter } = require("../../packages/core");

class TemplateBody extends BodyAdapter {
  static bodyName = "template";

  static tools = {
    move_to: {
      description: "Move toward an absolute position",
      parameters: {
        x: { type: "number", required: true },
        y: { type: "number", required: true },
      },
    },
    halt: {
      description: "Stop all motion",
      parameters: {},
    },
    avoid: {
      description: "Push away from current target",
      parameters: {},
    },
  };

  constructor() {
    super();
    this.position = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
    this.entities = [];
    this._spawnTick = 0;
  }

  // -- Tools --

  async move_to({ x, y }) {
    const dx = x - this.position.x;
    const dy = y - this.position.y;
    const len = Math.hypot(dx, dy) || 1;
    this.velocity.x = (dx / len) * 0.1;
    this.velocity.y = (dy / len) * 0.1;
    return { ok: true, target: { x, y } };
  }

  async halt() {
    this.velocity.x = 0;
    this.velocity.y = 0;
    return { ok: true };
  }

  async avoid() {
    this.velocity.x = -0.1;
    this.velocity.y = -0.1;
    return { ok: true };
  }

  // -- Sensor loop --

  async tick() {
    await super.tick();
    this._spawnTick++;

    this.position.x += this.velocity.x;
    this.position.y += this.velocity.y;

    // Spawn random entities occasionally
    if (Math.random() < 0.02) {
      const kinds = ["obstacle", "target", "noise"];
      const e = {
        id: `e${this._spawnTick}`,
        kind: kinds[Math.floor(Math.random() * kinds.length)],
        x: (Math.random() - 0.5) * 10,
        y: (Math.random() - 0.5) * 10,
      };
      this.entities.push(e);
      this.emit("entity_detected", { kind: e.kind }, "NORMAL");
    }

    // Age entities
    if (this.entities.length > 10) {
      this.entities = this.entities.slice(-10);
    }

    // Reflex: emergency halt if any entity within 0.5 units
    for (const e of this.entities) {
      const d = Math.hypot(e.x - this.position.x, e.y - this.position.y);
      if (d < 0.5) {
        this.velocity.x = 0;
        this.velocity.y = 0;
        this.emit("obstacle_too_close", { id: e.id }, "HIGH");
        break;
      }
    }

    this.setState({
      position: { x: this.position.x, y: this.position.y },
      entities_visible: this.entities.length,
    });
  }
}

module.exports = { TemplateBody };
