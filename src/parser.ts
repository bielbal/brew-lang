import { Token, TokenKind } from "./lexer";
import * as AST from "./ast";

export class ParseError extends Error {
    constructor(message: string, public token: Token) {
        super(`[${token.line}:${token.col}] ${message} (got ${token.kind} '${token.value}')`);
        this.name = "ParseError";
    }
}

export class Parser {
    private pos = 0;

    constructor(private tokens: Token[]) {}

    private peek(offset = 0): Token {
        return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    }

    private advance(): Token {
        const t = this.tokens[this.pos];
        if (t.kind !== "EOF") this.pos++;
        return t;
    }

    private check(...kinds: TokenKind[]): boolean {
        return kinds.includes(this.peek().kind);
    }

    private eat(...kinds: TokenKind[]): Token {
        const t = this.peek();
        if (!kinds.includes(t.kind)) throw new ParseError(`Expected ${kinds.join("|")}`, t);
        return this.advance();
    }

    private tryEat(...kinds: TokenKind[]): Token | null {
        if (this.check(...kinds)) return this.advance();
        return null;
    }

    private skipNewlines() {
        while (this.check("NEWLINE", "COMMENT")) this.advance();
    }

    // --- Type expressions ---
    private parseType(): AST.TypeExpr {
        const name = this.eat("IDENT").value;
        if (this.tryEat("LT")) {
            const params: AST.TypeExpr[] = [this.parseType()];
            while (this.tryEat("COMMA")) params.push(this.parseType());
            this.eat("GT");
            return { kind: "GenericType", name, params };
        }
        if (this.tryEat("QUESTION")) return { kind: "NullableType", inner: { kind: "SimpleType", name } };
        return { kind: "SimpleType", name };
    }

    private parseParam(): AST.Param {
        const rest = !!this.tryEat("SPREAD");
        const name = this.eat("IDENT").value;
        let type: AST.TypeExpr | undefined;
        if (this.tryEat("COLON")) type = this.parseType();
        let defaultValue: AST.Expr | undefined;
        if (this.tryEat("ASSIGN")) defaultValue = this.parseExpr();
        return { name, type, defaultValue, rest };
    }

    private parseParamList(): AST.Param[] {
        this.eat("LPAREN");
        const params: AST.Param[] = [];
        if (!this.check("RPAREN")) {
            params.push(this.parseParam());
            while (this.tryEat("COMMA")) {
                if (this.check("RPAREN")) break;
                params.push(this.parseParam());
            }
        }
        this.eat("RPAREN");
        return params;
    }

    // --- Block ---
    private parseBlock(): AST.Stmt[] {
        this.eat("NEWLINE");
        this.eat("INDENT");
        const stmts: AST.Stmt[] = [];
        while (!this.check("DEDENT", "EOF")) {
            this.skipNewlines();
            if (this.check("DEDENT", "EOF")) break;
            stmts.push(this.parseStmt());
        }
        this.tryEat("DEDENT");
        return stmts;
    }

    // --- Statements ---
    public parseProgram(): AST.Program {
        const stmts: AST.Stmt[] = [];
        this.skipNewlines();
        while (!this.check("EOF")) {
            stmts.push(this.parseStmt());
            this.skipNewlines();
        }
        return { stmts };
    }

    private parseStmt(): AST.Stmt {
        const t = this.peek();

        if (t.kind === "COMMENT") { this.advance(); return { kind: "Comment", text: t.value }; }

        if (t.kind === "EXPORT") {
            this.advance();
            const inner = this.parseStmt();
            if (inner.kind === "FnDecl" || inner.kind === "ClassDecl") {
                return { ...inner, exported: true } as AST.Stmt;
            }
            return inner;
        }

        if (t.kind === "IMPORT") return this.parseImport();
        if (t.kind === "FN") return this.parseFnDecl(false);
        if (t.kind === "CLASS") return this.parseClassDecl(false);
        if (t.kind === "RETURN") return this.parseReturn();
        if (t.kind === "IF") return this.parseIf();
        if (t.kind === "FOR") return this.parseFor();
        if (t.kind === "WHILE") return this.parseWhile();

        // var decl: name: Type = expr  OR  name = expr
        if (t.kind === "IDENT" && (this.peek(1).kind === "COLON" || this.peek(1).kind === "ASSIGN")) {
            return this.parseVarDecl();
        }

        // @ assignment: @prop = expr
        if (t.kind === "AT") {
            const expr = this.parseExpr();
            if (this.tryEat("ASSIGN")) {
                const val = this.parseExpr();
                this.tryEat("NEWLINE");
                return { kind: "ExprStmt", expr: { kind: "Assign", target: expr, value: val } };
            }
            this.tryEat("NEWLINE");
            return { kind: "ExprStmt", expr };
        }

        const expr = this.parseExpr();
        if (this.tryEat("ASSIGN")) {
            const val = this.parseExpr();
            this.tryEat("NEWLINE");
            return { kind: "ExprStmt", expr: { kind: "Assign", target: expr, value: val } };
        }
        this.tryEat("NEWLINE");
        return { kind: "ExprStmt", expr };
    }

    private parseImport(): AST.Stmt {
        this.eat("IMPORT");
        let defaultImport: string | undefined;
        const names: string[] = [];

        if (this.check("IDENT") && this.peek(1).kind !== "COMMA" && this.peek(1).kind !== "FROM") {
            // import Something from '...'  — but we'll treat bare IDENT as default
        }

        if (this.tryEat("LBRACE")) {
            names.push(this.eat("IDENT").value);
            while (this.tryEat("COMMA")) {
                if (this.check("RBRACE")) break;
                names.push(this.eat("IDENT").value);
            }
            this.eat("RBRACE");
        } else {
            defaultImport = this.eat("IDENT").value;
            if (this.tryEat("COMMA")) {
                this.eat("LBRACE");
                names.push(this.eat("IDENT").value);
                while (this.tryEat("COMMA")) names.push(this.eat("IDENT").value);
                this.eat("RBRACE");
            }
        }

        this.eat("FROM");
        const from = this.eat("STRING").value;
        this.tryEat("NEWLINE");
        return { kind: "Import", names, from, defaultImport };
    }

    private parseFnDecl(isStatic: boolean): AST.Stmt {
        void isStatic;
        this.eat("FN");
        const name = this.eat("IDENT").value;
        const params = this.parseParamList();
        let returnType: AST.TypeExpr | undefined;
        if (this.tryEat("ARROW")) returnType = this.parseType();
        const body = this.parseBlock();
        return { kind: "FnDecl", name, params, returnType, body, exported: false };
    }

    private parseClassDecl(_exported: boolean): AST.Stmt {
        this.eat("CLASS");
        const name = this.eat("IDENT").value;
        let superClass: string | undefined;
        if (this.tryEat("EXTENDS")) superClass = this.eat("IDENT").value;
        this.eat("NEWLINE");
        this.eat("INDENT");

        const members: AST.ClassMember[] = [];
        while (!this.check("DEDENT", "EOF")) {
            this.skipNewlines();
            if (this.check("DEDENT", "EOF")) break;

            const isStatic = !!this.tryEat("IDENT");  // skip 'static' keyword if present (treat as IDENT 'static')
            // Actually let's handle 'static' properly
            // We already consumed it if it was there — back up
            if (this.peek(-1 as number)?.value === "static") {
                // static method follows
                if (this.check("FN")) {
                    const m = this.parseClassMethod(true);
                    members.push(m);
                    continue;
                }
            }

            if (this.check("FN")) {
                members.push(this.parseClassMethod(false));
                continue;
            }

            // property: name: Type [= value]
            if (this.check("IDENT")) {
                const propName = this.advance().value;
                let type: AST.TypeExpr | undefined;
                if (this.tryEat("COLON")) type = this.parseType();
                let value: AST.Expr | undefined;
                if (this.tryEat("ASSIGN")) value = this.parseExpr();
                this.tryEat("NEWLINE");
                members.push({ kind: "Property", name: propName, type, value });
                continue;
            }

            this.advance();
        }

        this.tryEat("DEDENT");
        return { kind: "ClassDecl", name, superClass, body: members, exported: false };
    }

    private parseClassMethod(isStatic: boolean): AST.ClassMember {
        this.eat("FN");
        const name = this.eat("IDENT").value;
        const params = this.parseParamList();
        let returnType: AST.TypeExpr | undefined;
        if (this.tryEat("ARROW")) returnType = this.parseType();
        const body = this.parseBlock();
        return { kind: "Method", name, params, returnType, body, isStatic };
    }

    private parseReturn(): AST.Stmt {
        this.eat("RETURN");
        if (this.check("NEWLINE", "DEDENT", "EOF")) {
            this.tryEat("NEWLINE");
            return { kind: "Return" };
        }
        const value = this.parseExpr();
        this.tryEat("NEWLINE");
        return { kind: "Return", value };
    }

    private parseIf(): AST.Stmt {
        this.eat("IF");
        const cond = this.parseExpr();
        const then = this.parseBlock();
        const elifs: { cond: AST.Expr; body: AST.Stmt[] }[] = [];
        let elseBranch: AST.Stmt[] | undefined;

        while (this.check("ELIF")) {
            this.advance();
            const elifCond = this.parseExpr();
            const elifBody = this.parseBlock();
            elifs.push({ cond: elifCond, body: elifBody });
        }

        if (this.check("ELSE")) {
            this.advance();
            elseBranch = this.parseBlock();
        }

        return { kind: "If", cond, then, elifs, else: elseBranch };
    }

    private parseFor(): AST.Stmt {
        this.eat("FOR");
        const item = this.eat("IDENT").value;
        this.eat("IN");
        const iter = this.parseExpr();
        const body = this.parseBlock();
        return { kind: "For", item, iter, body };
    }

    private parseWhile(): AST.Stmt {
        this.eat("WHILE");
        const cond = this.parseExpr();
        const body = this.parseBlock();
        return { kind: "While", cond, body };
    }

    private parseVarDecl(): AST.Stmt {
        const name = this.eat("IDENT").value;
        let type: AST.TypeExpr | undefined;
        if (this.tryEat("COLON")) {
            // could be type annotation or just colon for object
            if (this.check("IDENT") && this.peek(1).kind !== "ASSIGN") {
                type = this.parseType();
            }
        }
        this.eat("ASSIGN");
        const value = this.parseExpr();
        this.tryEat("NEWLINE");
        return { kind: "VarDecl", name, type, value, mutable: true };
    }

    // --- Expressions (Pratt parser) ---
    private parseExpr(minPrec = 0): AST.Expr {
        let left = this.parseUnary();

        while (true) {
            const op = this.peek();
            const prec = this.binPrec(op.kind);
            if (prec <= minPrec) break;
            this.advance();
            const right = this.parseExpr(prec);
            left = { kind: "BinOp", op: op.value, left, right };
        }

        return left;
    }

    private binPrec(kind: TokenKind): number {
        switch (kind) {
            case "OR": return 1;
            case "AND": return 2;
            case "EQ": case "NEQ": return 3;
            case "LT": case "GT": case "LTE": case "GTE": return 4;
            case "PLUS": case "MINUS": return 5;
            case "STAR": case "SLASH": case "PERCENT": return 6;
            default: return 0;
        }
    }

    private parseUnary(): AST.Expr {
        if (this.check("NOT", "BANG")) {
            const op = this.advance().value;
            return { kind: "UnOp", op: op === "not" ? "!" : op, expr: this.parseUnary() };
        }
        if (this.check("MINUS")) {
            const op = this.advance().value;
            return { kind: "UnOp", op, expr: this.parseUnary() };
        }
        return this.parsePostfix();
    }

    private parsePostfix(): AST.Expr {
        let expr = this.parsePrimary();

        while (true) {
            if (this.check("DOT")) {
                this.advance();
                const optional = !!this.tryEat("QUESTION");
                const prop = this.eat("IDENT").value;
                expr = { kind: "Member", obj: expr, prop, optional };
            } else if (this.check("LBRACKET")) {
                this.advance();
                const index = this.parseExpr();
                this.eat("RBRACKET");
                expr = { kind: "Index", obj: expr, index };
            } else if (this.check("LPAREN")) {
                const args = this.parseArgList();
                expr = { kind: "Call", callee: expr, args };
            } else {
                break;
            }
        }

        return expr;
    }

    private parseArgList(): AST.Expr[] {
        this.eat("LPAREN");
        const args: AST.Expr[] = [];
        if (!this.check("RPAREN")) {
            args.push(this.check("SPREAD") ? (this.advance(), { kind: "Spread", expr: this.parseExpr() }) : this.parseExpr());
            while (this.tryEat("COMMA")) {
                if (this.check("RPAREN")) break;
                args.push(this.check("SPREAD") ? (this.advance(), { kind: "Spread", expr: this.parseExpr() }) : this.parseExpr());
            }
        }
        this.eat("RPAREN");
        return args;
    }

    private parsePrimary(): AST.Expr {
        const t = this.peek();

        if (t.kind === "NUMBER") { this.advance(); return { kind: "Number", value: t.value }; }

        if (t.kind === "STRING") {
            this.advance();
            // detect template: contains #{...}
            const template = t.value.includes("#{");
            return { kind: "String", value: t.value, template };
        }

        if (t.kind === "BOOL") { this.advance(); return { kind: "Bool", value: t.value === "true" }; }
        if (t.kind === "NULL") { this.advance(); return { kind: "Null" }; }

        if (t.kind === "AT") {
            this.advance();
            if (this.check("IDENT")) {
                const prop = this.advance().value;
                return { kind: "This", prop };
            }
            return { kind: "This" };
        }

        if (t.kind === "NEW") {
            this.advance();
            const callee: AST.Expr = { kind: "Ident", name: this.eat("IDENT").value };
            const args = this.check("LPAREN") ? this.parseArgList() : [];
            return { kind: "New", callee, args };
        }

        if (t.kind === "IDENT") {
            this.advance();
            return { kind: "Ident", name: t.value };
        }

        if (t.kind === "LPAREN") {
            this.advance();
            const expr = this.parseExpr();
            this.eat("RPAREN");
            return expr;
        }

        if (t.kind === "LBRACKET") {
            this.advance();
            const elements: AST.Expr[] = [];
            if (!this.check("RBRACKET")) {
                elements.push(this.parseExpr());
                while (this.tryEat("COMMA")) {
                    if (this.check("RBRACKET")) break;
                    elements.push(this.parseExpr());
                }
            }
            this.eat("RBRACKET");
            return { kind: "Array", elements };
        }

        if (t.kind === "LBRACE") {
            this.advance();
            const props: { key: string; value: AST.Expr }[] = [];
            while (!this.check("RBRACE", "EOF")) {
                const key = this.eat("IDENT").value;
                let value: AST.Expr;
                if (this.tryEat("COLON")) {
                    value = this.parseExpr();
                } else {
                    value = { kind: "Ident", name: key };
                }
                props.push({ key, value });
                this.tryEat("COMMA");
            }
            this.eat("RBRACE");
            return { kind: "Object", props };
        }

        throw new ParseError("Unexpected token", t);
    }
}
