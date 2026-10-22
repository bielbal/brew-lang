import { Token, TK, lex } from "./lexer";
import * as A from "./ast";

export function parse(src: string): A.Program {
  const tokens = lex(src).filter(t => t.kind !== "HASH" as TK); // strip stray #
  let pos = 0;

  const peek   = (off = 0): Token => tokens[pos + off] ?? tokens[tokens.length - 1];
  const cur    = (): Token => peek(0);
  const is     = (...kinds: TK[]): boolean => kinds.includes(cur().kind);
  const isNL   = (): boolean => is("NEWLINE", "SEMICOLON", "EOF");
  const adv    = (): Token => tokens[pos++];
  const expect = (kind: TK): Token => {
    if (!is(kind)) throw new SyntaxError(`[${cur().line}:${cur().col}] Expected ${kind}, got ${cur().kind} (${JSON.stringify(cur().value)})`);
    return adv();
  };
  const skipNL = () => { while (is("NEWLINE", "SEMICOLON")) adv(); };
  const eatNL  = () => { if (is("NEWLINE", "SEMICOLON")) adv(); };

  function parseBody(stopAt: TK[]): A.Node[] {
    skipNL();
    const nodes: A.Node[] = [];
    while (!is("EOF") && !stopAt.includes(cur().kind)) {
      nodes.push(parseStmt());
      while (is("NEWLINE", "SEMICOLON")) adv();
    }
    return nodes;
  }

  function parseStmt(): A.Node {
    skipNL();
    // modifier forms: expr if/unless/while/until COND
    let node = parseExprTop();
    if (is("IF")) {
      adv(); const cond = parseExprTop();
      return { type:"IfNode", cond, then:[node], elsifs:[], else_:undefined };
    }
    if (is("UNLESS")) {
      adv(); const cond = parseExprTop();
      return { type:"UnlessNode", cond, then:[node], else_:undefined };
    }
    if (is("WHILE")) {
      adv(); const cond = parseExprTop();
      return { type:"WhileNode", cond, body:[node] };
    }
    if (is("UNTIL")) {
      adv(); const cond = parseExprTop();
      return { type:"UntilNode", cond, body:[node] };
    }
    return node;
  }

  function parseExprTop(): A.Node {
    return parseAssign();
  }

  function parseAssign(): A.Node {
    const left = parseOr();

    if (is("ASSIGN") && cur().value === "=") {
      adv();
      skipNL();
      const value = parseAssign();
      return { type:"Assign", target:left, value };
    }
    if (is("PLUS_EQ","MINUS_EQ","STAR_EQ","SLASH_EQ","OR_EQ")) {
      const op = adv().value;
      skipNL();
      const value = parseAssign();
      return { type:"OpAssign", op, target:left, value };
    }
    // shovel << rewritten
    if (is("ASSIGN") && cur().value === "<<") {
      adv();
      skipNL();
      const value = parseAssign();
      return { type:"MethodCall", obj:left, method:"<<", args:[value] };
    }
    return left;
  }

  function parseOr(): A.Node {
    let left = parseAnd();
    while (is("OR")) { adv(); const right = parseAnd(); left = { type:"BinOp", op:"||", left, right }; }
    return left;
  }
  function parseAnd(): A.Node {
    let left = parseNot();
    while (is("AND")) { adv(); const right = parseNot(); left = { type:"BinOp", op:"&&", left, right }; }
    return left;
  }
  function parseNot(): A.Node {
    if (is("NOT")) { adv(); return { type:"UnaryOp", op:"!", operand:parseNot() }; }
    return parseTernary();
  }
  function parseTernary(): A.Node {
    let node = parseRange();
    if (is("QUESTION")) {
      adv(); const then_ = parseExprTop(); expect("COLON"); const else_ = parseExprTop();
      return { type:"IfNode", cond:node, then:[then_], elsifs:[], else_:[else_] };
    }
    return node;
  }
  function parseRange(): A.Node {
    const left = parseComparison();
    if (is("DOTDOT","DOTDOTDOT")) {
      const exclusive = is("DOTDOTDOT"); adv();
      const right = parseComparison();
      return { type:"RangeNode", from:left, to:right, exclusive };
    }
    return left;
  }
  function parseComparison(): A.Node {
    let left = parseAddSub();
    while (is("EQ","NEQ","LT","GT","LTE","GTE","SPACESHIP","MATCH")) {
      const op = adv().value;
      left = { type:"BinOp", op, left, right:parseAddSub() };
    }
    return left;
  }
  function parseAddSub(): A.Node {
    let left = parseMulDiv();
    while (is("PLUS","MINUS")) {
      const op = adv().value;
      skipNL();
      left = { type:"BinOp", op, left, right:parseMulDiv() };
    }
    return left;
  }
  function parseMulDiv(): A.Node {
    let left = parsePow();
    while (is("STAR","SLASH","PERCENT")) {
      const op = adv().value;
      left = { type:"BinOp", op, left, right:parsePow() };
    }
    return left;
  }
  function parsePow(): A.Node {
    const left = parseUnary();
    if (is("DSTAR")) { adv(); return { type:"BinOp", op:"**", left, right:parsePow() }; }
    return left;
  }
  function parseUnary(): A.Node {
    if (is("BANG"))  { adv(); return { type:"UnaryOp", op:"!", operand:parseUnary() }; }
    if (is("MINUS")) { adv(); return { type:"UnaryOp", op:"-", operand:parseUnary() }; }
    if (is("PLUS"))  { adv(); return { type:"UnaryOp", op:"+", operand:parseUnary() }; }
    if (is("AMP"))   { adv(); return { type:"UnaryOp", op:"&", operand:parseUnary() }; }
    return parseCallChain();
  }

  function parseCallChain(): A.Node {
    let node = parsePrimary();
    while (true) {
      if (is("DOT")) {
        adv();
        const method = adv().value;
        const args   = is("LPAREN") ? parseArgList() : [];
        const block  = tryParseBlock();
        node = { type:"MethodCall", obj:node, method, args, block, safe:false };
      } else if (is("DCOLON")) {
        adv();
        const name = adv().value;
        if (is("LPAREN")) {
          const args = parseArgList();
          node = { type:"MethodCall", obj:node, method:name, args, safe:false };
        } else {
          node = { type:"MethodCall", obj:node, method:name, args:[], safe:false };
        }
      } else if (is("LBRACKET")) {
        adv(); skipNL();
        const index = parseExprTop(); skipNL(); expect("RBRACKET");
        if (is("ASSIGN") && cur().value === "=") {
          adv();
          const value = parseExprTop();
          return { type:"IndexSet", obj:node, index, value };
        }
        node = { type:"IndexGet", obj:node, index };
      } else if (is("QUESTION") && !isNL()) {
        // safe navigation a&.b handled in lexer as AMP dot — here just break
        break;
      } else {
        break;
      }
    }
    return node;
  }

  function parseArgList(): A.Node[] {
    expect("LPAREN"); skipNL();
    const args: A.Node[] = [];
    while (!is("RPAREN","EOF")) {
      if (is("AMP")) { adv(); args.push({ type:"UnaryOp", op:"&", operand:parseExprTop() }); }
      else args.push(parseExprTop());
      skipNL();
      if (is("COMMA")) { adv(); skipNL(); }
    }
    expect("RPAREN");
    return args;
  }

  function tryParseBlock(): A.BlockNode | undefined {
    if (is("DO")) {
      adv(); eatNL();
      const params = tryParseBlockParams();
      const body   = parseBody(["END"]);
      expect("END");
      return { type:"BlockNode", params, body };
    }
    if (is("LBRACE")) {
      adv(); skipNL();
      const params = tryParseBlockParams();
      const body   = parseBody(["RBRACE"]);
      expect("RBRACE");
      return { type:"BlockNode", params, body };
    }
    return undefined;
  }

  function tryParseBlockParams(): string[] {
    if (!is("PIPE")) return [];
    adv();
    const params: string[] = [];
    while (!is("PIPE","EOF")) {
      params.push(expect("IDENT").value);
      if (is("COMMA")) adv();
    }
    expect("PIPE");
    return params;
  }

  function parsePrimary(): A.Node {
    const t = cur();

    // keywords with structure
    if (is("DEF"))       return parseDef();
    if (is("CLASS"))     return parseClass();
    if (is("MODULE"))    return parseModule();
    if (is("IF"))        return parseIf();
    if (is("UNLESS"))    return parseUnless();
    if (is("WHILE"))     return parseWhile();
    if (is("UNTIL"))     return parseUntil();
    if (is("FOR"))       return parseFor();
    if (is("BEGIN_KW"))  return parseBegin();
    if (is("CASE" as TK)) return parseCase() as A.Node;

    if (is("RETURN")) {
      adv();
      const value = isNL() ? undefined : parseExprTop();
      return { type:"ReturnNode", value };
    }
    if (is("YIELD")) {
      adv();
      const args = is("LPAREN") ? parseArgList() : [];
      return { type:"YieldNode", args };
    }
    if (is("RAISE")) {
      adv();
      const value = parseExprTop();
      return { type:"RaiseNode", value };
    }
    if (is("BREAK")) {
      adv();
      const value = isNL() ? undefined : parseExprTop();
      return { type:"BreakNode", value };
    }
    if (is("NEXT")) {
      adv();
      const value = isNL() ? undefined : parseExprTop();
      return { type:"NextNode", value };
    }
    if (is("SUPER")) {
      adv();
      const args = is("LPAREN") ? parseArgList() : [];
      return { type:"SuperNode", args };
    }

    // lambda { |x| } or ->(x) { }
    if (is("LAMBDA")) {
      adv();
      const block = tryParseBlock();
      if (block) return { type:"LambdaNode", params:block.params.map(n=>({ name:n })), body:block.body } as A.LambdaNode;
      return { type:"LambdaNode", params:[], body:[] };
    }
    if (is("ARROW")) {
      return parseLambda();
    }

    // literals
    if (is("INT"))    { adv(); return { type:"IntLit",   value: parseInt(t.value, 10) }; }
    if (is("FLOAT"))  { adv(); return { type:"FloatLit", value: parseFloat(t.value) }; }
    if (is("BOOL"))   { adv(); return { type:"BoolLit",  value: t.value === "true" }; }
    if (is("NIL"))    { adv(); return { type:"NilLit" }; }
    if (is("SELF"))   { adv(); return { type:"SelfNode" }; }

    if (is("STRING")) {
      adv();
      const v = t.value;
      // word array
      if (v.startsWith("\x04")) return { type:"ArrayLit", elements: v.slice(1).trim().split(/\s+/).filter(Boolean).map(s => ({ type:"StrLit", value:s } as A.StrLit)) };
      if (v.startsWith("\x05")) return { type:"ArrayLit", elements: v.slice(1).trim().split(/\s+/).filter(Boolean).map(s => ({ type:"SymLit", name:s } as A.SymLit)) };
      // interpolated
      if (v.startsWith("\x01")) return parseInterpolated(v.slice(1));
      return { type:"StrLit", value:v };
    }

    if (is("SYMBOL")) { adv(); return { type:"SymLit", name:t.value }; }
    if (is("IVAR"))   { adv(); return { type:"IVar", name:t.value }; }
    if (is("CVAR"))   { adv(); return { type:"CVar", name:t.value }; }
    if (is("GVAR"))   { adv(); return { type:"GVar", name:t.value }; }

    if (is("CONST")) {
      adv();
      // call with parens or args on same line
      if (is("LPAREN")) {
        const args = parseArgList();
        const block = tryParseBlock();
        return { type:"Call", callee:{ type:"Const", name:t.value }, args, block };
      }
      return { type:"Const", name:t.value };
    }

    if (is("IDENT")) {
      adv();
      if (is("ASSIGN") && cur().value === "=" && (peek(1).kind as string) !== "=") {
        // simple local var assign handled in parseAssign — so here it's a call
      }
      if (is("LPAREN")) {
        const args = parseArgList();
        const block = tryParseBlock();
        return { type:"Call", callee:{ type:"Ident", name:t.value }, args, block };
      }
      // call without parens (implicit args until NL) only for known keywords
      // For simplicity: if next token is not NL/op/EOF treat as call
      const callKeywords = new Set(["puts","print","pp","require","require_relative","raise","include","extend","attr_accessor","attr_reader","attr_writer"]);
      if (callKeywords.has(t.value) && !isNL() && !is("EOF","DOT","COMMA","RPAREN","RBRACKET","RBRACE","END","ELSE","ELSIF","THEN","DO","NEWLINE","SEMICOLON")) {
        const args: A.Node[] = [];
        while (!isNL() && !is("EOF","RPAREN","RBRACKET","RBRACE","END","ELSE","ELSIF","DO","AND","OR","IF","UNLESS","WHILE","UNTIL")) {
          if (is("AMP")) { adv(); args.push({ type:"UnaryOp", op:"&", operand:parseExprTop() }); break; }
          args.push(parseExprTop());
          if (is("COMMA")) { adv(); skipNL(); } else break;
        }
        const block = tryParseBlock();
        return { type:"Call", callee:{ type:"Ident", name:t.value }, args, block };
      }
      const block = tryParseBlock();
      if (block) return { type:"Call", callee:{ type:"Ident", name:t.value }, args:[], block };
      return { type:"Ident", name:t.value };
    }

    // array literal
    if (is("LBRACKET")) {
      adv(); skipNL();
      const elements: A.Node[] = [];
      while (!is("RBRACKET","EOF")) {
        if (is("STAR")) { adv(); elements.push({ type:"UnaryOp", op:"*", operand:parseExprTop() }); }
        else elements.push(parseExprTop());
        skipNL();
        if (is("COMMA")) { adv(); skipNL(); }
      }
      expect("RBRACKET");
      return { type:"ArrayLit", elements };
    }

    // hash literal { k => v } or { k: v }
    if (is("LBRACE")) {
      adv(); skipNL();
      // if first meaningful token is |, it's a block (standalone brace block)
      if (is("PIPE")) {
        const params = tryParseBlockParams();
        const body   = parseBody(["RBRACE"]);
        expect("RBRACE");
        return { type:"BlockNode", params, body } as unknown as A.Node;
      }
      const pairs: {key:A.Node;value:A.Node}[] = [];
      while (!is("RBRACE","EOF")) {
        let key: A.Node;
        if (is("IDENT") && peek(1).kind === "COLON") {
          key = { type:"SymLit", name:adv().value }; adv();
        } else if (is("SYMBOL") && peek(1).kind === "FAT_ARROW") {
          key = { type:"SymLit", name:adv().value }; adv();
        } else {
          key = parseExprTop();
          expect("FAT_ARROW");
        }
        skipNL();
        const value = parseExprTop();
        pairs.push({ key, value });
        skipNL();
        if (is("COMMA")) { adv(); skipNL(); }
      }
      expect("RBRACE");
      return { type:"HashLit", pairs };
    }

    // grouped
    if (is("LPAREN")) {
      adv(); skipNL();
      const node = parseExprTop();
      skipNL(); expect("RPAREN");
      return node;
    }

    throw new SyntaxError(`[${t.line}:${t.col}] Unexpected token: ${t.kind} (${JSON.stringify(t.value)})`);
  }

  function parseInterpolated(raw: string): A.InterpolatedStr {
    const parts: (string | A.Node)[] = [];
    let buf = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "\x02") {
        if (buf) { parts.push(buf); buf = ""; }
        i++;
        let expr = "";
        while (i < raw.length && raw[i] !== "\x03") expr += raw[i++];
        i++;
        try { parts.push(parse(expr).body[0] as A.Node); } catch { parts.push(expr); }
      } else {
        buf += raw[i++];
      }
    }
    if (buf) parts.push(buf);
    return { type:"InterpolatedStr", parts };
  }

  function parseParams(): A.Param[] {
    if (!is("LPAREN")) return [];
    expect("LPAREN");
    const params: A.Param[] = [];
    while (!is("RPAREN","EOF")) {
      let splat = false, block = false, keyword = false;
      if (is("STAR")) { adv(); splat = true; }
      else if (is("AMP")) { adv(); block = true; }
      const name = adv().value;
      let default_: A.Node | undefined;
      if (is("ASSIGN") && cur().value === "=") { adv(); default_ = parseExprTop(); }
      else if (is("COLON")) { adv(); keyword = true; if (!isNL() && !is("COMMA","RPAREN")) default_ = parseExprTop(); }
      params.push({ name, default_, splat, block, keyword });
      if (is("COMMA")) adv();
    }
    expect("RPAREN");
    return params;
  }

  function parseDef(): A.MethodDef | A.SingletonMethodDef {
    expect("DEF");
    // def self.name or def obj.name
    if (is("SELF") || (is("IDENT") && peek(1).kind === "DOT")) {
      const obj: A.Node = is("SELF") ? (adv(), { type:"SelfNode" }) : { type:"Ident", name:adv().value };
      expect("DOT");
      const name   = adv().value;
      const params = parseParams();
      eatNL();
      const body = parseBody(["END","RESCUE","ENSURE"]);
      // rescue inline
      if (is("RESCUE")) {
        adv();
        const rb = parseBody(["END"]);
        expect("END");
        return { type:"SingletonMethodDef", obj, name, params, body:[{ type:"BeginRescue", body, rescues:[{ body:rb }], ensure_:undefined }] };
      }
      expect("END");
      return { type:"SingletonMethodDef", obj, name, params, body };
    }
    const name   = adv().value;
    const params = parseParams();
    eatNL();
    const body = parseBody(["END","RESCUE","ENSURE"]);
    if (is("RESCUE")) {
      adv();
      const rb = parseBody(["END"]);
      expect("END");
      return { type:"MethodDef", name, params, body:[{ type:"BeginRescue", body, rescues:[{ body:rb }], ensure_:undefined }] };
    }
    expect("END");
    return { type:"MethodDef", name, params, body };
  }

  function parseClass(): A.ClassDef {
    expect("CLASS");
    const name = expect("CONST").value;
    let super_: string | undefined;
    if (is("LT")) { adv(); super_ = expect("CONST").value; }
    eatNL();
    const body = parseBody(["END"]);
    expect("END");
    return { type:"ClassDef", name, super_, body };
  }

  function parseModule(): A.ModuleDef {
    expect("MODULE");
    const name = expect("CONST").value;
    eatNL();
    const body = parseBody(["END"]);
    expect("END");
    return { type:"ModuleDef", name, body };
  }

  function parseIf(): A.IfNode {
    expect("IF"); skipNL();
    const cond = parseExprTop();
    if (is("THEN")) adv(); eatNL();
    const then = parseBody(["ELSIF","ELSE","END"]);
    const elsifs: {cond:A.Node;body:A.Node[]}[] = [];
    while (is("ELSIF")) {
      adv(); const ec = parseExprTop(); if (is("THEN")) adv(); eatNL();
      elsifs.push({ cond:ec, body:parseBody(["ELSIF","ELSE","END"]) });
    }
    let else_: A.Node[] | undefined;
    if (is("ELSE")) { adv(); eatNL(); else_ = parseBody(["END"]); }
    expect("END");
    return { type:"IfNode", cond, then, elsifs, else_ };
  }

  function parseUnless(): A.UnlessNode {
    expect("UNLESS"); skipNL();
    const cond = parseExprTop();
    if (is("THEN")) adv(); eatNL();
    const then = parseBody(["ELSE","END"]);
    let else_: A.Node[] | undefined;
    if (is("ELSE")) { adv(); eatNL(); else_ = parseBody(["END"]); }
    expect("END");
    return { type:"UnlessNode", cond, then, else_ };
  }

  function parseWhile(): A.WhileNode {
    expect("WHILE"); skipNL();
    const cond = parseExprTop(); if (is("DO","THEN")) adv(); eatNL();
    const body = parseBody(["END"]);
    expect("END");
    return { type:"WhileNode", cond, body };
  }

  function parseUntil(): A.UntilNode {
    expect("UNTIL"); skipNL();
    const cond = parseExprTop(); if (is("DO","THEN")) adv(); eatNL();
    const body = parseBody(["END"]);
    expect("END");
    return { type:"UntilNode", cond, body };
  }

  function parseFor(): A.ForIn {
    expect("FOR");
    const vars: string[] = [];
    vars.push(expect("IDENT").value);
    while (is("COMMA")) { adv(); vars.push(expect("IDENT").value); }
    expect("IN");
    const iter = parseExprTop();
    if (is("DO","THEN")) adv(); eatNL();
    const body = parseBody(["END"]);
    expect("END");
    return { type:"ForIn", vars, iter, body };
  }

  function parseBegin(): A.BeginRescue {
    expect("BEGIN_KW"); eatNL();
    const body = parseBody(["RESCUE","ENSURE","END"]);
    const rescues: A.BeginRescue["rescues"] = [];
    while (is("RESCUE")) {
      adv();
      let klass: string | undefined, var_: string | undefined;
      if (is("CONST")) klass = adv().value;
      if (is("FAT_ARROW") || (is("ASSIGN") && cur().value === "=>")) { adv(); var_ = expect("IDENT").value; }
      eatNL();
      rescues.push({ klass, var_, body:parseBody(["RESCUE","ENSURE","END"]) });
    }
    let ensure_: A.Node[] | undefined;
    if (is("ENSURE")) { adv(); eatNL(); ensure_ = parseBody(["END"]); }
    expect("END");
    return { type:"BeginRescue", body, rescues, ensure_ };
  }

  function parseCase(): object {
    expect("CASE" as TK); eatNL();
    let subject: A.Node | undefined;
    if (!is("WHEN" as TK)) subject = parseExprTop();
    eatNL();
    const whens: {values:A.Node[];body:A.Node[]}[] = [];
    while (is("WHEN" as TK)) {
      adv();
      const values: A.Node[] = [parseExprTop()];
      while (is("COMMA")) { adv(); values.push(parseExprTop()); }
      if (is("THEN")) adv(); eatNL();
      const wbody = parseBody(["WHEN" as TK,"ELSE","END"]);
      whens.push({ values, body:wbody });
    }
    let else_: A.Node[] | undefined;
    if (is("ELSE")) { adv(); eatNL(); else_ = parseBody(["END"]); }
    expect("END");
    return { type:"CaseNode", subject, whens, else_ };
  }

  function parseLambda(): A.LambdaNode {
    if (is("ARROW")) adv();
    const params = is("LPAREN") ? parseParams() : [];
    skipNL();
    let body: A.Node[];
    if (is("LBRACE")) {
      adv(); skipNL();
      body = parseBody(["RBRACE"]);
      expect("RBRACE");
    } else if (is("DO")) {
      adv(); eatNL();
      body = parseBody(["END"]);
      expect("END");
    } else {
      body = [parseExprTop()];
    }
    return { type:"LambdaNode", params, body };
  }

  const body = parseBody(["EOF"]);
  return { type:"Program", body };
}
