/** @import { type Config } from "prettier" */
// We need this file to use .js instead of .ts until https://github.com/prettier/prettier-vscode/issues/3623 is fixed.

/** @type {Config} */
const config = {
  // The Oxc plugin makes prettier faster but unfortunately isn't working with the VSCode extension at the moment.
  // plugins: ["@prettier/plugin-oxc"],
  experimentalTernaries: true,
  experimentalOperatorPosition: "start",
  bracketSameLine: true,
};

export default config;
