// Starfish morphing spinner. No external deps.
// frames: ['✦', '✧', '✶', '✷', '✸', '✷', '✶', '✧']

const c = require("./colors");

const FRAMES = ["\u2726", "\u2727", "\u2736", "\u2737", "\u2738", "\u2737", "\u2736", "\u2727"];

class Spinner {
  constructor(label = "") {
    this.label = label;
    this.i = 0;
    this._timer = null;
  }

  start() {
    if (!c.enabled || !process.stdout.isTTY) {
      // In non-TTY environments (pipes, CI), emit a single frame once.
      process.stdout.write(`${c.indigo(FRAMES[0])} ${this.label}\n`);
      return this;
    }
    this._timer = setInterval(() => {
      const frame = FRAMES[this.i++ % FRAMES.length];
      process.stdout.write(`\r${c.indigo(frame)} ${this.label}   `);
    }, 120);
    return this;
  }

  stop(finalLine = null) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K"); // clear line
    }
    if (finalLine !== null) console.log(finalLine);
  }
}

module.exports = { Spinner, FRAMES };
