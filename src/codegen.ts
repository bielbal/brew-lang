import * as AST from "./ast";

export class CodeGen {
    private lines: string[] = [];
    private indent = 0;

    private emit(line: string) {
        this.lines.push("  ".repeat(this.indent) + line);
    }

    private block(fn: () => void) {
        this.indent++;
        fn();
        this.indent--;
    }

    public generate(program: AST.Program): string {
        for (const stmt of program.stmts) this.genStmt(stmt);
        return this.lines.join("\n");
    }

    private genStmt(s: AST.Stmt) {
        switch (s.kind) {
            case "Comment": this.emit(`// ${s.text}`); break;
            case "Import": this.genImport(s); break;
            case "FnDecl": this.genFnDecl(s); break;
            case "ClassDecl": this.genClassDecl(s); break;
            case "VarDecl": this.genVarDecl(s); break;
            case "Return": this.emit(`return${s.value ? " " + this.genExpr(s.value) : ""};`); break;
            case "If": this.genIf(s); break;
            case "For": this.genFor(s); break;
            case "While": this.genWhile(s); break;
            case "ExprStmt": this.emit(this.genExpr(s.expr) + ";"); break;
        }
    }

    private genImport(s: AST.Stmt & { kind: "Import" }) {
        const parts: string[] = [];
        if (s.defaultImport) parts.push(s.defaultImport);
        if (s.names.length) parts.push(`{ ${s.names.join(", ")} }`);
        this.emit(`import ${parts.join(", ")} from '${s.from}';`);
    }

    private genFnDecl(s: AST.Stmt & { kind: "FnDecl" }) {
        const params = s.params.map(this.genParam.bind(this)).join(", ");
        const prefix = s.exported ? "export " : "";
        this.emit(`${prefix}function ${s.name}(${params}) {`);
        this.block(() => {
            const body = [...s.body];
            // implicit return: last stmt if it's an ExprStmt
            if (body.length) {
                const last = body[body.length - 1];
                if (last.kind === "ExprStmt" && s.returnType) {
                    body[body.length - 1] = { kind: "Return", value: last.expr };
                }
            }
            for (const stmt of body) this.genStmt(stmt);
        });
        this.emit("}");
        this.emit("");
    }

    private genParam(p: AST.Param): string {
        const prefix = p.rest ? "..." : "";
        const def = p.defaultValue ? ` = ${this.genExpr(p.defaultValue)}` : "";
        return `${prefix}${p.name}${def}`;
    }

    private genClassDecl(s: AST.Stmt & { kind: "ClassDecl" }) {
        const ext = s.superClass ? ` extends ${s.superClass}` : "";
        const prefix = s.exported ? "export " : "";
        this.emit(`${prefix}class ${s.name}${ext} {`);
        this.block(() => {
            // properties first (as field declarations)
            const props = s.body.filter((m) => m.kind === "Property") as (AST.ClassMember & { kind: "Property" })[];
            for (const p of props) {
                const val = p.value ? ` = ${this.genExpr(p.value)}` : "";
                this.emit(`${p.name}${val};`);
            }
            if (props.length) this.emit("");

            // methods
            const methods = s.body.filter((m) => m.kind === "Method") as (AST.ClassMember & { kind: "Method" })[];
            for (const m of methods) {
                const st = m.isStatic ? "static " : "";
                const params = m.params.map(this.genParam.bind(this)).join(", ");
                this.emit(`${st}${m.name}(${params}) {`);
                this.block(() => {
                    const body = [...m.body];
                    if (body.length && m.name !== "constructor" && m.returnType) {
                        const last = body[body.length - 1];
                        if (last.kind === "ExprStmt") {
                            body[body.length - 1] = { kind: "Return", value: last.expr };
                        }
                    }
                    for (const stmt of body) this.genStmt(stmt);
                });
                this.emit("}");
                this.emit("");
            }
        });
        this.emit("}");
        this.emit("");
    }

    private genVarDecl(s: AST.Stmt & { kind: "VarDecl" }) {
        const kw = s.mutable ? "let" : "const";
        this.emit(`${kw} ${s.name} = ${this.genExpr(s.value)};`);
    }

    private genIf(s: AST.Stmt & { kind: "If" }) {
        this.emit(`if (${this.genExpr(s.cond)}) {`);
        this.block(() => s.then.forEach((st) => this.genStmt(st)));
        for (const elif of s.elifs) {
            this.emit(`} else if (${this.genExpr(elif.cond)}) {`);
            this.block(() => elif.body.forEach((st) => this.genStmt(st)));
        }
        if (s.else) {
            this.emit("} else {");
            this.block(() => s.else!.forEach((st) => this.genStmt(st)));
        }
        this.emit("}");
    }

    private genFor(s: AST.Stmt & { kind: "For" }) {
        this.emit(`for (const ${s.item} of ${this.genExpr(s.iter)}) {`);
        this.block(() => s.body.forEach((st) => this.genStmt(st)));
        this.emit("}");
    }

    private genWhile(s: AST.Stmt & { kind: "While" }) {
        this.emit(`while (${this.genExpr(s.cond)}) {`);
        this.block(() => s.body.forEach((st) => this.genStmt(st)));
        this.emit("}");
    }

    private genExpr(e: AST.Expr): string {
        switch (e.kind) {
            case "Ident": return e.name;
            case "Number": return e.value;
            case "Bool": return String(e.value);
            case "Null": return "null";
            case "This": return e.prop ? `this.${e.prop}` : "this";

            case "String": {
                if (!e.template) return `"${e.value}"`;
                // Convert #{expr} → ${expr}, and @prop → this.prop inside expressions
                const converted = e.value.replace(/#\{([^}]+)\}/g, (_, expr) => {
                    const jsExpr = expr.replace(/@([a-zA-Z_$][a-zA-Z0-9_$]*)/g, "this.$1");
                    return "${" + jsExpr + "}";
                });
                return "`" + converted + "`";
            }

            case "Array": return `[${e.elements.map((el) => this.genExpr(el)).join(", ")}]`;
            case "Object": return `{ ${e.props.map((p) => `${p.key}: ${this.genExpr(p.value)}`).join(", ")} }`;
            case "Spread": return `...${this.genExpr(e.expr)}`;

            case "Member": {
                const op = e.optional ? "?." : ".";
                return `${this.genExpr(e.obj)}${op}${e.prop}`;
            }

            case "Index": return `${this.genExpr(e.obj)}[${this.genExpr(e.index)}]`;
            case "Call": return `${this.genExpr(e.callee)}(${e.args.map((a) => this.genExpr(a)).join(", ")})`;
            case "New": return `new ${this.genExpr(e.callee)}(${e.args.map((a) => this.genExpr(a)).join(", ")})`;

            case "BinOp": {
                const op = e.op === "and" ? "&&" : e.op === "or" ? "||" : e.op;
                return `${this.genExpr(e.left)} ${op} ${this.genExpr(e.right)}`;
            }

            case "UnOp": return `${e.op}${this.genExpr(e.expr)}`;

            case "Assign": return `${this.genExpr(e.target)} = ${this.genExpr(e.value)}`;
        }
    }
}
