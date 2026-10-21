export type TokenKind =
    | "IDENT" | "NUMBER" | "STRING" | "BOOL" | "NULL"
    | "NEWLINE" | "INDENT" | "DEDENT" | "EOF"
    | "FN" | "CLASS" | "EXTENDS" | "RETURN" | "NEW"
    | "IF" | "ELIF" | "ELSE" | "FOR" | "IN" | "WHILE"
    | "IMPORT" | "FROM" | "EXPORT" | "DEFAULT"
    | "COLON" | "COMMA" | "DOT" | "ARROW" | "ASSIGN"
    | "LPAREN" | "RPAREN" | "LBRACKET" | "RBRACKET" | "LBRACE" | "RBRACE"
    | "AT" | "HASH" | "SPREAD"
    | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT"
    | "EQ" | "NEQ" | "LT" | "GT" | "LTE" | "GTE"
    | "AND" | "OR" | "NOT" | "QUESTION" | "BANG"
    | "COMMENT";

export interface Token {
    kind: TokenKind;
    value: string;
    line: number;
    col: number;
}

const KEYWORDS: Record<string, TokenKind> = {
    fn: "FN", class: "CLASS", extends: "EXTENDS", return: "RETURN",
    if: "IF", elif: "ELIF", else: "ELSE", for: "FOR", in: "IN", while: "WHILE",
    import: "IMPORT", from: "FROM", export: "EXPORT", default: "DEFAULT",
    new: "NEW", true: "BOOL", false: "BOOL", null: "NULL", undefined: "NULL",
    and: "AND", or: "OR", not: "NOT",
    // These are NOT keywords in Brew — force them to IDENT
    // (constructor, prototype, etc. are valid method names)
};

export function lex(source: string): Token[] {
    const tokens: Token[] = [];
    const lines = source.split("\n");
    const indentStack: number[] = [0];

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const raw = lines[lineNum];
        const trimmed = raw.trimEnd();
        if (!trimmed || trimmed.trimStart().startsWith("#")) {
            if (trimmed.trimStart().startsWith("#")) {
                tokens.push({ kind: "COMMENT", value: trimmed.trimStart().slice(1).trim(), line: lineNum + 1, col: 1 });
            }
            continue;
        }

        // Measure indent
        let indent = 0;
        while (indent < trimmed.length && (trimmed[indent] === " " || trimmed[indent] === "\t")) {
            indent += trimmed[indent] === "\t" ? 2 : 1;
        }

        const curIndent = indentStack[indentStack.length - 1];
        if (indent > curIndent) {
            indentStack.push(indent);
            tokens.push({ kind: "INDENT", value: "", line: lineNum + 1, col: 1 });
        } else {
            while (indent < indentStack[indentStack.length - 1]) {
                indentStack.pop();
                tokens.push({ kind: "DEDENT", value: "", line: lineNum + 1, col: 1 });
            }
        }

        // Tokenize the line content
        let i = indent;
        const line = lineNum + 1;

        while (i < trimmed.length) {
            const col = i + 1;
            const ch = trimmed[i];

            // skip whitespace
            if (ch === " " || ch === "\t") { i++; continue; }

            // inline comment
            if (ch === "#") {
                tokens.push({ kind: "COMMENT", value: trimmed.slice(i + 1).trim(), line, col });
                break;
            }

            // string with template support: "..." or '...'
            if (ch === '"' || ch === "'") {
                const q = ch;
                let s = "";
                i++;
                while (i < trimmed.length && trimmed[i] !== q) {
                    if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
                        s += trimmed[i] + trimmed[i + 1];
                        i += 2;
                    } else {
                        s += trimmed[i++];
                    }
                }
                i++; // closing quote
                tokens.push({ kind: "STRING", value: s, line, col });
                continue;
            }

            // number
            if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(trimmed[i + 1] ?? ""))) {
                let n = "";
                while (i < trimmed.length && /[0-9._]/.test(trimmed[i])) n += trimmed[i++];
                tokens.push({ kind: "NUMBER", value: n, line, col });
                continue;
            }

            // identifier or keyword
            if (/[a-zA-Z_$]/.test(ch)) {
                let id = "";
                while (i < trimmed.length && /[a-zA-Z0-9_$]/.test(trimmed[i])) id += trimmed[i++];
                const kind: TokenKind = Object.prototype.hasOwnProperty.call(KEYWORDS, id) ? KEYWORDS[id] : "IDENT";
                tokens.push({ kind, value: id, line, col });
                continue;
            }

            // two-char operators
            const two = trimmed.slice(i, i + 2);
            const twoMap: Record<string, TokenKind> = {
                "->": "ARROW", "==": "EQ", "!=": "NEQ", "<=": "LTE", ">=": "GTE",
                "&&": "AND", "||": "OR", "...": "SPREAD",
            };
            if (twoMap[two]) { tokens.push({ kind: twoMap[two], value: two, line, col }); i += 2; continue; }

            // single-char
            const oneMap: Record<string, TokenKind> = {
                ":": "COLON", ",": "COMMA", ".": "DOT", "=": "ASSIGN",
                "(": "LPAREN", ")": "RPAREN", "[": "LBRACKET", "]": "RBRACKET",
                "{": "LBRACE", "}": "RBRACE", "@": "AT",
                "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH", "%": "PERCENT",
                "<": "LT", ">": "GT", "!": "BANG", "?": "QUESTION",
            };
            if (oneMap[ch]) { tokens.push({ kind: oneMap[ch], value: ch, line, col }); i++; continue; }

            i++; // skip unknown
        }

        tokens.push({ kind: "NEWLINE", value: "", line, col: trimmed.length });
    }

    // close remaining indents
    while (indentStack.length > 1) {
        indentStack.pop();
        tokens.push({ kind: "DEDENT", value: "", line: lines.length, col: 0 });
    }

    tokens.push({ kind: "EOF", value: "", line: lines.length + 1, col: 0 });
    return tokens;
}
