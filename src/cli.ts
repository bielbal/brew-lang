#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { lex }         from "./lexer";
import { parse }       from "./parser";
import { Interpreter } from "./interpreter";
import { rubyInspect } from "./object";

const args = process.argv.slice(2);

if (args[0] === "--tokens" && args[1]) {
  const src = fs.readFileSync(args[1], "utf8");
  for (const t of lex(src)) console.log(`${t.kind.padEnd(16)} ${JSON.stringify(t.value)}`);
  process.exit(0);
}

if (args[0] === "--ast" && args[1]) {
  const src = fs.readFileSync(args[1], "utf8");
  console.log(JSON.stringify(parse(src), null, 2));
  process.exit(0);
}

if (args[0] === "-e" && args[1]) {
  const interp = new Interpreter();
  try {
    const ast = parse(args[1]);
    interp.run(ast);
  } catch (e) { console.error((e as Error).message); process.exit(1); }
  process.exit(0);
}

if (args.length > 0 && !args[0].startsWith("-")) {
  const file = args[0];
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }
  const src = fs.readFileSync(file, "utf8");
  const interp = new Interpreter();
  interp.globalEnv.setLocal("__FILE__", { type:"string", value:path.resolve(file) });
  interp.globalEnv.setLocal("__DIR__",  { type:"string", value:path.dirname(path.resolve(file)) });
  try {
    const ast = parse(src);
    interp.run(ast);
  } catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(1); }
  process.exit(0);
}

// REPL
const interp = new Interpreter();
console.log("Brew 2.0 – Ruby-like interpreter (TypeScript)");
console.log("Type 'exit' or Ctrl+D to quit.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: ">> " });
let buf = "";

rl.prompt();
rl.on("line", (line: string) => {
  if (line.trim() === "exit") { console.log("Bye!"); process.exit(0); }

  buf += (buf ? "\n" : "") + line;

  // try to parse; if incomplete keep buffering
  try {
    const ast = parse(buf);
    const result = interp.run(ast);
    if (buf.trim()) console.log("=> " + rubyInspect(result));
    buf = "";
  } catch (e) {
    const msg = (e as Error).message;
    // if it looks like an incomplete expression, keep buffering
    if (msg.includes("Expected") || msg.includes("Unexpected token: EOF")) {
      rl.setPrompt(".. ");
      rl.prompt();
      return;
    }
    console.error("Error: " + msg);
    buf = "";
  }

  rl.setPrompt(">> ");
  rl.prompt();
});

rl.on("close", () => { console.log("\nBye!"); process.exit(0); });
