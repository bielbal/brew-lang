export type TK =
  | "INT" | "FLOAT" | "STRING" | "SYMBOL" | "BOOL" | "NIL" | "SELF"
  | "IDENT" | "IVAR" | "CVAR" | "GVAR" | "CONST"
  | "NEWLINE" | "EOF"
  | "DEF" | "END" | "CLASS" | "MODULE" | "DO" | "IF" | "UNLESS"
  | "ELSE" | "ELSIF" | "THEN" | "WHILE" | "UNTIL" | "FOR" | "IN"
  | "RETURN" | "YIELD" | "RAISE" | "RESCUE" | "ENSURE" | "BEGIN_KW"
  | "SUPER" | "LAMBDA" | "PROC" | "AND" | "OR" | "NOT" | "BREAK" | "NEXT"
  | "LPAREN" | "RPAREN" | "LBRACKET" | "RBRACKET" | "LBRACE" | "RBRACE"
  | "DOT" | "DOTDOT" | "DOTDOTDOT" | "COMMA" | "COLON" | "DCOLON"
  | "SEMICOLON" | "PIPE" | "AMP" | "PERCENT"
  | "ASSIGN" | "PLUS_EQ" | "MINUS_EQ" | "STAR_EQ" | "SLASH_EQ" | "OR_EQ"
  | "ARROW" | "FAT_ARROW" | "BACKSLASH"
  | "PLUS" | "MINUS" | "STAR" | "DSTAR" | "SLASH"
  | "EQ" | "NEQ" | "LT" | "GT" | "LTE" | "GTE" | "SPACESHIP" | "MATCH"
  | "BANG" | "QUESTION" | "AT" | "HASH" | "CASE" | "WHEN" | "PROC";

export interface Token { kind: TK; value: string; line: number; col: number }

const KW: Record<string, TK> = {
  def:"DEF", end:"END", class:"CLASS", module:"MODULE", do:"DO",
  if:"IF", unless:"UNLESS", else:"ELSE", elsif:"ELSIF", then:"THEN",
  while:"WHILE", until:"UNTIL", for:"FOR", in:"IN",
  return:"RETURN", yield:"YIELD", raise:"RAISE", rescue:"RESCUE",
  ensure:"ENSURE", begin:"BEGIN_KW", super:"SUPER",
  lambda:"LAMBDA",
  true:"BOOL", false:"BOOL", nil:"NIL", self:"SELF", __FILE__:"IDENT", __DIR__:"IDENT",
  and:"AND", or:"OR", not:"NOT", break:"BREAK", next:"NEXT",
  case:"CASE", when:"WHEN", proc:"PROC",
};

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0, line = 1, col = 1;

  const ch  = (off = 0) => src[i + off] ?? "";
  const adv = () => { const c = src[i++]; if (c === "\n") { line++; col = 1; } else col++; return c; };
  const eat = (s: string) => { if (src.startsWith(s, i)) { i += s.length; col += s.length; return true; } return false; };
  const tok = (kind: TK, value: string, l = line, c = col): Token => ({ kind, value, line: l, col: c });
  const push = (kind: TK, value: string, l?: number, c?: number) => toks.push(tok(kind, value, l, c));
  const last = () => toks[toks.length - 1];

  while (i < src.length) {
    const sl = line, sc = col;

    // whitespace (not newline)
    if (ch() === " " || ch() === "\t" || ch() === "\r") { adv(); continue; }

    // line continuation
    if (ch() === "\\" && ch(1) === "\n") { adv(); adv(); continue; }

    // newline
    if (ch() === "\n") {
      adv();
      const l = last();
      const nlOk = !l || ["NEWLINE","COMMA","DOT","PLUS","MINUS","STAR","SLASH","ASSIGN","LPAREN","LBRACKET","LBRACE","OR","AND","PIPE","FAT_ARROW","BACKSLASH","THEN","DO"].includes(l.kind);
      if (!nlOk) push("NEWLINE", "\n", sl, sc);
      continue;
    }

    // comment
    if (ch() === "#") {
      while (i < src.length && ch() !== "\n") adv();
      continue;
    }

    // multiline string / heredoc — skip for simplicity, handle =begin/=end
    if (src.startsWith("=begin", i) && (i === 0 || src[i-1] === "\n")) {
      while (i < src.length && !src.startsWith("=end", i)) adv();
      eat("=end"); continue;
    }

    // double-quoted string with interpolation marker
    if (ch() === '"') {
      adv();
      let val = "", interp = false;
      while (i < src.length && ch() !== '"') {
        if (ch() === '\\') { adv(); const e = adv(); val += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; }
        else if (ch() === '#' && ch(1) === '{') { val += '\x02'; interp = true; let d = 1; adv(); adv(); while (i < src.length && d > 0) { if (ch() === '{') d++; if (ch() === '}') d--; if (d > 0) val += adv(); else adv(); } val += '\x03'; }
        else val += adv();
      }
      adv();
      push(interp ? "STRING" : "STRING", val, sl, sc);
      // mark interpolated strings with a prefix so evaluator knows
      if (interp) toks[toks.length-1].value = "\x01" + val;
      continue;
    }

    // single-quoted string
    if (ch() === "'") {
      adv(); let val = "";
      while (i < src.length && ch() !== "'") {
        if (ch() === '\\' && ch(1) === "'") { adv(); val += adv(); }
        else val += adv();
      }
      adv();
      push("STRING", val, sl, sc);
      continue;
    }

    // symbol :name or :"..." or %s(...)
    if (ch() === ":" && /[a-zA-Z_"]/.test(ch(1))) {
      adv();
      if (ch() === '"') {
        adv(); let s = "";
        while (i < src.length && ch() !== '"') s += adv();
        adv(); push("SYMBOL", s, sl, sc);
      } else {
        let s = "";
        while (/[a-zA-Z0-9_?!=]/.test(ch())) s += adv();
        push("SYMBOL", s, sl, sc);
      }
      continue;
    }

    // word arrays %w(...) %i(...)
    if (ch() === "%" && (ch(1) === "w" || ch(1) === "i")) {
      const isStr = ch(1) === "w";
      adv(); adv();
      const open = adv(); const close = open === "(" ? ")" : open === "[" ? "]" : "}";
      let val = "";
      while (i < src.length && ch() !== close) val += adv();
      adv();
      // emit as a special STRING token that evaluator converts
      push("STRING", (isStr ? "\x04" : "\x05") + val, sl, sc);
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch())) {
      let n = "";
      while (/[0-9_]/.test(ch())) n += adv();
      if (ch() === "." && /[0-9]/.test(ch(1))) {
        n += adv();
        while (/[0-9_]/.test(ch())) n += adv();
        push("FLOAT", n.replace(/_/g,""), sl, sc);
      } else {
        push("INT", n.replace(/_/g,""), sl, sc);
      }
      continue;
    }

    // instance var @name
    if (ch() === "@" && ch(1) === "@" && /[a-zA-Z_]/.test(ch(2))) {
      adv(); adv(); let n = "@@"; while (/[a-zA-Z0-9_]/.test(ch())) n += adv();
      push("CVAR", n, sl, sc); continue;
    }
    if (ch() === "@" && /[a-zA-Z_]/.test(ch(1))) {
      adv(); let n = "@"; while (/[a-zA-Z0-9_]/.test(ch())) n += adv();
      push("IVAR", n, sl, sc); continue;
    }

    // global var $name
    if (ch() === "$" && /[a-zA-Z_0-9]/.test(ch(1))) {
      adv(); let n = "$"; while (/[a-zA-Z0-9_]/.test(ch())) n += adv();
      push("GVAR", n, sl, sc); continue;
    }

    // identifiers / keywords
    if (/[a-zA-Z_]/.test(ch())) {
      let id = "";
      while (/[a-zA-Z0-9_?!]/.test(ch())) id += adv();
      // CONST if starts uppercase
      const kind: TK = KW[id] ?? (/^[A-Z]/.test(id) ? "CONST" : "IDENT");
      push(kind, id, sl, sc);
      continue;
    }

    // operators & punctuation
    const c0 = adv();
    switch (c0) {
      case "(": push("LPAREN","(",sl,sc); break;
      case ")": push("RPAREN",")",sl,sc); break;
      case "[": push("LBRACKET","[",sl,sc); break;
      case "]": push("RBRACKET","]",sl,sc); break;
      case "{": push("LBRACE","{",sl,sc); break;
      case "}": push("RBRACE","}",sl,sc); break;
      case ",": push("COMMA",",",sl,sc); break;
      case ";": push("SEMICOLON",";",sl,sc); break;
      case "|": push("PIPE","|",sl,sc); break;
      case "\\": push("BACKSLASH","\\",sl,sc); break;
      case "%": push("PERCENT","%",sl,sc); break;
      case ".":
        if (eat("..")) push("DOTDOTDOT","...",sl,sc);
        else if (eat(".")) push("DOTDOT","..",sl,sc);
        else push("DOT",".",sl,sc); break;
      case ":":
        if (eat(":")) push("DCOLON","::",sl,sc);
        else push("COLON",":",sl,sc); break;
      case "=":
        if (ch() === ">" && src[i+1] !== ">") { adv(); push("FAT_ARROW","=>",sl,sc); }
        else if (eat("=")) push("EQ","==",sl,sc);
        else if (eat("~")) push("MATCH","=~",sl,sc);
        else push("ASSIGN","=",sl,sc); break;
      case "!":
        if (eat("=")) push("NEQ","!=",sl,sc);
        else push("BANG","!",sl,sc); break;
      case "<":
        if (eat("<")) push("ASSIGN","<<",sl,sc); // shovel — reuse ASSIGN with value
        else if (eat("=>")) push("SPACESHIP","<=>",sl,sc);
        else if (eat("=")) push("LTE","<=",sl,sc);
        else push("LT","<",sl,sc); break;
      case ">":
        if (eat("=")) push("GTE",">=",sl,sc);
        else push("GT",">",sl,sc); break;
      case "+":
        if (eat("=")) push("PLUS_EQ","+=",sl,sc);
        else push("PLUS","+",sl,sc); break;
      case "-":
        if (eat(">")) push("ARROW","->",sl,sc);
        else if (eat("=")) push("MINUS_EQ","-=",sl,sc);
        else push("MINUS","-",sl,sc); break;
      case "*":
        if (eat("*")) push("DSTAR","**",sl,sc);
        else if (eat("=")) push("STAR_EQ","*=",sl,sc);
        else push("STAR","*",sl,sc); break;
      case "/":
        if (eat("=")) push("SLASH_EQ","/=",sl,sc);
        else push("SLASH","/",sl,sc); break;
      case "&":
        if (eat("&")) push("AND","&&",sl,sc);
        else push("AMP","&",sl,sc); break;
      case "?": push("QUESTION","?",sl,sc); break;
      case "@": push("AT","@",sl,sc); break;
      case "#": push("HASH","#",sl,sc); break;
      // unknown — skip
    }
  }

  push("EOF", "", line, col);
  return toks;
}
