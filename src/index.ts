import { lex } from "./lexer";
import { Parser } from "./parser";
import { CodeGen } from "./codegen";
import { collectTypes, generateTypesFile } from "./typegen";
import * as AST from "./ast";

export { lex, Parser, CodeGen, collectTypes, generateTypesFile };
export type { AST };

export interface CompileResult {
    /** Transpiled JavaScript source */
    js: string;
    /** Generated types.js source */
    types: string;
    /** Collected type names */
    typeNames: Set<string>;
}

export function compile(source: string): CompileResult {
    const tokens = lex(source);
    const parser = new Parser(tokens);
    const program = parser.parseProgram();
    const codegen = new CodeGen();
    const js = codegen.generate(program);
    const typeNames = collectTypes(program);
    const types = generateTypesFile(typeNames);
    return { js, types, typeNames };
}
