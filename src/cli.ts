#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { compile } from "./index";

const program = new Command();

program
    .name("brew")
    .description("Brew language transpiler — compiles .brew files to .js + types.js")
    .version("0.1.0");

program
    .command("compile <files...>")
    .alias("c")
    .description("Compile .brew files to JavaScript")
    .option("-o, --out <dir>", "Output directory", ".")
    .option("--no-types", "Skip generating types.js")
    .option("--shared-types", "Generate a single shared types.js instead of one per file")
    .action((files: string[], opts: { out: string; types: boolean; sharedTypes: boolean }) => {
        const outDir = path.resolve(opts.out);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        const allTypeNames = new Set<string>();

        for (const file of files) {
            const src = fs.readFileSync(path.resolve(file), "utf-8");
            const basename = path.basename(file, ".brew");

            try {
                const result = compile(src);

                // Write .js
                const jsPath = path.join(outDir, basename + ".js");
                const header = opts.sharedTypes
                    ? `import { Types } from './types.js';\n\n`
                    : opts.types
                        ? `import { Types } from './${basename}.types.js';\n\n`
                        : "";
                fs.writeFileSync(jsPath, header + result.js, "utf-8");
                console.log(`✓ ${file} → ${path.relative(".", jsPath)}`);

                if (!opts.sharedTypes && opts.types && result.typeNames.size > 0) {
                    // Per-file types
                    const typesPath = path.join(outDir, basename + ".types.js");
                    fs.writeFileSync(typesPath, result.types, "utf-8");
                    console.log(`  + ${path.relative(".", typesPath)} (${result.typeNames.size} types)`);
                }

                result.typeNames.forEach((t) => allTypeNames.add(t));
            } catch (e) {
                console.error(`✗ ${file}: ${(e as Error).message}`);
                process.exit(1);
            }
        }

        // Shared types.js
        if (opts.sharedTypes && allTypeNames.size > 0) {
            const { generateTypesFile } = require("./typegen");
            const typesPath = path.join(outDir, "types.js");
            fs.writeFileSync(typesPath, generateTypesFile(allTypeNames), "utf-8");
            console.log(`\n→ types.js (${allTypeNames.size} types): ${path.relative(".", typesPath)}`);
        }
    });

program
    .command("print <file>")
    .description("Print the transpiled JS to stdout without writing files")
    .action((file: string) => {
        const src = fs.readFileSync(path.resolve(file), "utf-8");
        const { js, types, typeNames } = compile(src);
        console.log("// ===== types.js =====");
        console.log(types);
        console.log("\n// ===== " + path.basename(file, ".brew") + ".js =====");
        console.log(js);
        void typeNames;
    });

program.parse();
