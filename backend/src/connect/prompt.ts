import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export type Prompter = {
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
};

export class CancelledError extends Error {}

const NOT_A_TERMINAL =
  "npm run connect needs a terminal for hidden input. Run it in PowerShell, Terminal or the VS Code terminal.";

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

const askHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!stdin.isTTY) return reject(new CancelledError(NOT_A_TERMINAL));
    stdout.write(question);
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value);
        }
        if (ch === "\u0003") {
          finish();
          return reject(new CancelledError("Cancelled."));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });

export const terminalPrompter: Prompter = { ask, askHidden };
