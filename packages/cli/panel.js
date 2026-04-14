// Box-drawing panels. No external deps.

const c = require("./colors");

function visibleLength(str) {
  // Strip ANSI escapes for width calculation
  return String(str).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(str, width) {
  const len = visibleLength(str);
  if (len >= width) return str;
  return str + " ".repeat(width - len);
}

function box(lines, opts = {}) {
  const color = opts.color || c.indigo;
  const padding = opts.padding ?? 1;

  const maxLen = Math.max(...lines.map(visibleLength));
  const inner = maxLen + padding * 2;

  const top    = color("\u2554" + "\u2550".repeat(inner) + "\u2557");
  const bottom = color("\u255A" + "\u2550".repeat(inner) + "\u255D");

  const out = [top];
  for (const line of lines) {
    out.push(color("\u2551") + " ".repeat(padding) + pad(line, maxLen) + " ".repeat(padding) + color("\u2551"));
  }
  out.push(bottom);
  return out.join("\n");
}

module.exports = { box };
