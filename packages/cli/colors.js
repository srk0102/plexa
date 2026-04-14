// ANSI color codes using the plexa palette.
// No dependencies -- works anywhere Node runs.

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR !== "1";

function wrap(open, close) {
  return (s) => USE_COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
}

module.exports = {
  // Base styles
  reset:     "\x1b[0m",
  bold:      wrap(1, 22),
  dim:       wrap(2, 22),
  italic:    wrap(3, 23),
  underline: wrap(4, 24),

  // Brand palette (approximated with ANSI 256-color)
  indigo:   wrap("38;5;99", 39),   // #4F46E5 → close to 99
  violet:   wrap("38;5;147", 39),  // #818CF8 → 147
  green:    wrap("38;5;42", 39),   // #10B981 → 42
  white:    wrap(97, 39),
  gray:     wrap("38;5;244", 39),
  red:      wrap(91, 39),
  yellow:   wrap(93, 39),
  cyan:     wrap(96, 39),
  blue:     wrap(94, 39),

  // Priority styles (for log stream)
  priority: {
    CRITICAL: (s) => `\x1b[91m\x1b[1m${s}\x1b[0m`,
    HIGH:     (s) => `\x1b[93m${s}\x1b[0m`,
    NORMAL:   (s) => `\x1b[97m${s}\x1b[0m`,
    LOW:      (s) => `\x1b[2m${s}\x1b[0m`,
  },

  // Brand marks
  starfish: "\u2726",  // ✦
  star:     "\u2605",  // ★
  dot:      "\u2022",  // •

  enabled: USE_COLOR,
};
