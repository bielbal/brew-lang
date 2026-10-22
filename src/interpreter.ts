import * as A from "./ast";
import {
  RubyValue, RubyInt, RubyFloat, RubyString, RubySymbol, RubyBool,
  RubyNil, RubyArray, RubyHash, RubyProc, RubyClass, RubyModule, RubyObject,
  RubyRange, RubyReturn, RubyBreak, RubyNext,
  Env, NIL, TRUE, FALSE,
  isTruthy, rubyInspect, rubyToS, hashKey, rubyEq
} from "./object";

class BreakSignal  { constructor(public value: RubyValue) {} }
class NextSignal   { constructor(public value: RubyValue) {} }
class ReturnSignal { constructor(public value: RubyValue) {} }
class RubyError    { constructor(public message: string, public rubyClass?: string) {} }

export class Interpreter {
  globalEnv: Env;
  classes = new Map<string, RubyClass>();
  modules = new Map<string, RubyModule>();
  stdout: (s: string) => void;

  constructor(opts?: { stdout?: (s: string) => void }) {
    this.stdout = opts?.stdout ?? (s => process.stdout.write(s));
    this.globalEnv = new Env();
    this.registerCoreClasses();
  }

  // ── entry ────────────────────────────────────────────────────────────────────

  run(program: A.Program): RubyValue {
    return this.evalBody(program.body, this.globalEnv);
  }

  // ── body / statements ────────────────────────────────────────────────────────

  evalBody(nodes: A.Node[], env: Env): RubyValue {
    let result: RubyValue = NIL;
    for (const node of nodes) {
      result = this.eval(node, env);
      if (result && (result as any).type === "__return") return result;
      if (result && (result as any).type === "__break")  throw new BreakSignal((result as RubyBreak).value);
      if (result && (result as any).type === "__next")   throw new NextSignal((result as RubyNext).value);
    }
    return result;
  }

  eval(node: A.Node, env: Env): RubyValue {
    switch (node.type) {
      // literals
      case "IntLit":   return { type:"int",    value:node.value };
      case "FloatLit": return { type:"float",  value:node.value };
      case "StrLit":   return { type:"string", value:node.value };
      case "SymLit":   return { type:"symbol", name:node.name };
      case "BoolLit":  return node.value ? TRUE : FALSE;
      case "NilLit":   return NIL;
      case "SelfNode": return env.get("__self") ?? NIL;

      case "InterpolatedStr": {
        let s = "";
        for (const p of node.parts)
          s += typeof p === "string" ? p : rubyToS(this.eval(p as A.Node, env));
        return { type:"string", value:s };
      }

      case "ArrayLit": {
        const elements: RubyValue[] = [];
        for (const el of node.elements) {
          if (el.type === "UnaryOp" && el.op === "*") {
            const splat = this.eval(el.operand, env);
            if (splat.type === "array") elements.push(...splat.elements);
            else elements.push(splat);
          } else elements.push(this.eval(el, env));
        }
        return { type:"array", elements };
      }

      case "HashLit": {
        const map = new Map<string, RubyValue>();
        const keys: RubyValue[] = [];
        for (const { key, value } of node.pairs) {
          const k = this.eval(key, env), v = this.eval(value, env);
          const hk = hashKey(k);
          if (!map.has(hk)) keys.push(k);
          map.set(hk, v);
        }
        return { type:"hash", map, keys };
      }

      case "RangeNode": {
        const from = this.eval(node.from, env), to = this.eval(node.to, env);
        if (from.type !== "int" || to.type !== "int") throw new Error("Range requires integers");
        return { type:"range", from:from.value, to:to.value, exclusive:node.exclusive };
      }

      // variables
      case "Ident": return env.get(node.name);
      case "Const": {
        const cls = this.classes.get(node.name) ?? this.modules.get(node.name);
        if (cls) return cls as RubyValue;
        return env.get(node.name);
      }
      case "IVar": {
        const self = env.get("__self");
        if (self.type === "object") return self.ivars.get(node.name) ?? NIL;
        return env.get(node.name);
      }
      case "CVar": {
        const self = env.get("__self");
        if (self.type === "object" || self.type === "class") {
          const cls = self.type === "class" ? self : self.klass;
          return cls.constants.get(node.name) ?? NIL;
        }
        return env.get(node.name);
      }
      case "GVar": return this.globalEnv.get(node.name);

      // assignment
      case "Assign": {
        const val = this.eval(node.value, env);
        this.assign(node.target, val, env);
        return val;
      }
      case "OpAssign": {
        const curr = this.eval(node.target, env);
        const rhs  = this.eval(node.value, env);
        const op   = node.op.replace("=","");
        const result = this.applyOp(op, curr, rhs, env);
        this.assign(node.target, result, env);
        return result;
      }
      case "MultiAssign": {
        const val = this.eval(node.value, env);
        const arr = val.type === "array" ? val.elements : [val];
        node.targets.forEach((t,i) => env.setLocal(t, arr[i] ?? NIL));
        return val;
      }

      // control
      case "ReturnNode": {
        const v = node.value ? this.eval(node.value, env) : NIL;
        throw new ReturnSignal(v);
      }
      case "BreakNode": {
        const v = node.value ? this.eval(node.value, env) : NIL;
        throw new BreakSignal(v);
      }
      case "NextNode": {
        const v = node.value ? this.eval(node.value, env) : NIL;
        throw new NextSignal(v);
      }
      case "YieldNode": {
        const block = env.get("__block") as RubyProc | undefined;
        if (!block || block.type !== "proc") throw new Error("No block given");
        const args = node.args.map(a => this.eval(a, env));
        return this.callProc(block, args, env);
      }
      case "RaiseNode": {
        const v = this.eval(node.value, env);
        const msg = v.type === "string" ? v.value : rubyInspect(v);
        throw new Error(msg);
      }

      // conditionals
      case "IfNode": {
        if (isTruthy(this.eval(node.cond, env))) return this.evalBody(node.then, env);
        for (const ei of node.elsifs)
          if (isTruthy(this.eval(ei.cond, env))) return this.evalBody(ei.body, env);
        if (node.else_) return this.evalBody(node.else_, env);
        return NIL;
      }
      case "UnlessNode": {
        if (!isTruthy(this.eval(node.cond, env))) return this.evalBody(node.then, env);
        if (node.else_) return this.evalBody(node.else_, env);
        return NIL;
      }
      case "CaseNode": {
        const subj = node.subject ? this.eval(node.subject, env) : TRUE;
        for (const when of node.whens) {
          for (const wv of when.values) {
            const val = this.eval(wv, env);
            if (rubyEq(subj, val)) return this.evalBody(when.body, env);
            if (val.type === "class") {
              if (subj.type === "object" && subj.klass === val) return this.evalBody(when.body, env);
            }
          }
        }
        if (node.else_) return this.evalBody(node.else_, env);
        return NIL;
      }

      // loops
      case "WhileNode": {
        let result: RubyValue = NIL;
        while (isTruthy(this.eval(node.cond, env))) {
          try { result = this.evalBody(node.body, env); }
          catch (e) { if (e instanceof BreakSignal) return e.value; if (e instanceof NextSignal) continue; throw e; }
        }
        return result;
      }
      case "UntilNode": {
        let result: RubyValue = NIL;
        while (!isTruthy(this.eval(node.cond, env))) {
          try { result = this.evalBody(node.body, env); }
          catch (e) { if (e instanceof BreakSignal) return e.value; if (e instanceof NextSignal) continue; throw e; }
        }
        return result;
      }
      case "ForIn": {
        const iter = this.eval(node.iter, env);
        const items = this.toArray(iter);
        let result: RubyValue = NIL;
        for (const item of items) {
          if (node.vars.length === 1) env.setLocal(node.vars[0], item);
          else {
            const arr = item.type === "array" ? item.elements : [item];
            node.vars.forEach((v,i) => env.setLocal(v, arr[i] ?? NIL));
          }
          try { result = this.evalBody(node.body, env); }
          catch (e) { if (e instanceof BreakSignal) return e.value; if (e instanceof NextSignal) continue; throw e; }
        }
        return result;
      }

      // begin/rescue
      case "BeginRescue": {
        try {
          return this.evalBody(node.body, env);
        } catch (e) {
          for (const r of node.rescues) {
            const msg = e instanceof Error ? e.message : String(e);
            if (r.var_) env.setLocal(r.var_, { type:"string", value:msg });
            try { return this.evalBody(r.body, env); }
            catch (re) { throw re; }
          }
          throw e;
        } finally {
          if (node.ensure_) this.evalBody(node.ensure_, env);
        }
      }

      // definitions
      case "ClassDef": {
        let cls = this.classes.get(node.name);
        if (!cls) {
          const superCls = node.super_ ? this.classes.get(node.super_) : undefined;
          cls = {
            type:"class", name:node.name,
            super_:superCls,
            methods:new Map(), classMethods:new Map(),
            constants:new Map(), modules:[]
          };
          this.classes.set(node.name, cls);
        }
        const classEnv = new Env(env);
        classEnv.setLocal("__self", cls as RubyValue);
        this.evalClassBody(node.body, cls, classEnv);
        return cls as RubyValue;
      }
      case "ModuleDef": {
        let mod = this.modules.get(node.name);
        if (!mod) {
          mod = { type:"module", name:node.name, methods:new Map(), constants:new Map() };
          this.modules.set(node.name, mod);
        }
        const modEnv = new Env(env);
        modEnv.setLocal("__self", mod as RubyValue);
        this.evalModuleBody(node.body, mod, modEnv);
        return mod as RubyValue;
      }

      // function / proc expressions
      case "LambdaNode":
        return { type:"proc", params:node.params.map(p=>p.name), body:node.body, closure:env, isLambda:true };

      // calls
      case "Call":     return this.evalCall(node, env);
      case "MethodCall": return this.evalMethodCall(node, env);
      case "SuperNode": return this.evalSuper(node, env);

      // index
      case "IndexGet": {
        const obj = this.eval(node.obj, env);
        const idx = this.eval(node.index, env);
        return this.callMethod(obj, "[]", [idx], undefined, env);
      }
      case "IndexSet": {
        const obj = this.eval(node.obj, env);
        const idx = this.eval(node.index, env);
        const val = this.eval(node.value, env);
        return this.callMethod(obj, "[]=", [idx, val], undefined, env);
      }

      // unary / binary
      case "UnaryOp": {
        if (node.op === "&") {
          // symbol-to-proc: &:method
          const v = this.eval(node.operand, env);
          if (v.type === "symbol") {
            return { type:"proc", params:["__it"], body:[], closure:env,
              isLambda:false, ...{ _symProc:v.name } } as any;
          }
          return v;
        }
        const v = this.eval(node.operand, env);
        switch (node.op) {
          case "!":  return isTruthy(v) ? FALSE : TRUE;
          case "-":  return v.type === "int" ? { type:"int", value:-v.value } : v.type === "float" ? { type:"float", value:-v.value } : NIL;
          case "+":  return v;
        }
        return NIL;
      }
      case "BinOp": return this.evalBinOp(node, env);

      case "ExprStmt": return this.eval(node.expr, env);

      default:
        throw new Error(`Unknown node type: ${(node as any).type}`);
    }
  }

  // ── assignment helper ──────────────────────────────────────────────────────

  assign(target: A.Node, value: RubyValue, env: Env) {
    switch (target.type) {
      case "Ident": env.setLocal(target.name, value); break;
      case "Const": env.setLocal(target.name, value); break;
      case "IVar": {
        const self = env.get("__self");
        if (self.type === "object") self.ivars.set(target.name, value);
        else env.setLocal(target.name, value);
        break;
      }
      case "CVar": {
        const self = env.get("__self");
        if (self.type === "object" || self.type === "class") {
          const cls = self.type === "class" ? self : self.klass;
          cls.constants.set(target.name, value);
        } else env.setLocal(target.name, value);
        break;
      }
      case "GVar": this.globalEnv.setLocal(target.name, value); break;
      case "IndexGet": {
        const obj = this.eval((target as A.IndexGet).obj, env);
        const idx = this.eval((target as A.IndexGet).index, env);
        this.callMethod(obj, "[]=", [idx, value], undefined, env);
        break;
      }
      case "MethodCall": {
        const obj = this.eval((target as A.MethodCall).obj, env);
        const args = (target as A.MethodCall).args.map(a => this.eval(a, env));
        this.callMethod(obj, (target as A.MethodCall).method + "=", [...args, value], undefined, env);
        break;
      }
      default: throw new Error(`Cannot assign to ${target.type}`);
    }
  }

  // ── class / module body ────────────────────────────────────────────────────

  evalClassBody(nodes: A.Node[], cls: RubyClass, env: Env) {
    for (const node of nodes) {
      if (node.type === "MethodDef") {
        const proc: RubyProc = { type:"proc", params:node.params.map(p=>p.name), body:node.body, closure:env };
        (proc as any)._name = node.name;
        cls.methods.set(node.name, proc);
      } else if (node.type === "SingletonMethodDef") {
        const proc: RubyProc = { type:"proc", params:node.params.map(p=>p.name), body:node.body, closure:env };
        cls.classMethods.set(node.name, proc);
      } else if (node.type === "Call" && node.callee.type === "Ident") {
        const name = (node.callee as A.Ident).name;
        if (name === "attr_accessor" || name === "attr_reader" || name === "attr_writer") {
          const args = node.args.map(a => this.eval(a, env));
          for (const sym of args) {
            if (sym.type !== "symbol") continue;
            const n = sym.name;
            if (name !== "attr_writer")
              cls.methods.set(n, this.makeAttrReader(n));
            if (name !== "attr_reader")
              cls.methods.set(n + "=", this.makeAttrWriter(n));
          }
        } else if (name === "include") {
          const mod = this.modules.get((node.args[0] as A.Ident).name ?? (node.args[0] as A.Const)?.name ?? "");
          if (mod) cls.modules.push(mod);
        } else {
          this.eval(node, env);
        }
      } else {
        this.eval(node, env);
      }
    }
  }

  evalModuleBody(nodes: A.Node[], mod: RubyModule, env: Env) {
    for (const node of nodes) {
      if (node.type === "MethodDef") {
        const proc: RubyProc = { type:"proc", params:node.params.map(p=>p.name), body:node.body, closure:env };
        mod.methods.set(node.name, proc);
      } else {
        this.eval(node, env);
      }
    }
  }

  makeAttrReader(name: string): RubyProc {
    return { type:"proc", params:[], body:[], closure:this.globalEnv, _attrReader:name } as any;
  }
  makeAttrWriter(name: string): RubyProc {
    return { type:"proc", params:["val"], body:[], closure:this.globalEnv, _attrWriter:name } as any;
  }

  // ── binary ops ────────────────────────────────────────────────────────────

  evalBinOp(node: A.BinOp, env: Env): RubyValue {
    const { op } = node;
    if (op === "&&") return isTruthy(this.eval(node.left, env)) ? this.eval(node.right, env) : FALSE;
    if (op === "||") { const l = this.eval(node.left, env); return isTruthy(l) ? l : this.eval(node.right, env); }
    const left  = this.eval(node.left, env);
    const right = this.eval(node.right, env);
    return this.applyOp(op, left, right, env);
  }

  applyOp(op: string, left: RubyValue, right: RubyValue, env: Env): RubyValue {
    // numeric
    if ((left.type === "int" || left.type === "float") && (right.type === "int" || right.type === "float")) {
      const a = left.value, b = right.value;
      const isFloat = left.type === "float" || right.type === "float";
      const num = (v: number): RubyValue => isFloat ? { type:"float", value:v } : { type:"int", value:v };
      switch (op) {
        case "+": return num(a + b);
        case "-": return num(a - b);
        case "*": return num(a * b);
        case "/": return isFloat ? { type:"float", value:a/b } : { type:"int", value:Math.trunc(a/b) };
        case "%": return { type:"int", value:((a % b) + b) % b };
        case "**": return num(a ** b);
        case "==": return a === b ? TRUE : FALSE;
        case "!=": return a !== b ? TRUE : FALSE;
        case "<":  return a < b ? TRUE : FALSE;
        case ">":  return a > b ? TRUE : FALSE;
        case "<=": return a <= b ? TRUE : FALSE;
        case ">=": return a >= b ? TRUE : FALSE;
        case "<=>": return { type:"int", value: a<b ? -1 : a>b ? 1 : 0 };
      }
    }
    // string
    if (left.type === "string") {
      switch (op) {
        case "+": return { type:"string", value:left.value + rubyToS(right) };
        case "*": return { type:"string", value:left.value.repeat((right as RubyInt).value) };
        case "==": return left.value === (right as RubyString).value ? TRUE : FALSE;
        case "!=": return left.value !== (right as RubyString).value ? TRUE : FALSE;
        case "<":  return left.value <  (right as RubyString).value ? TRUE : FALSE;
        case ">":  return left.value >  (right as RubyString).value ? TRUE : FALSE;
        case "<=": return left.value <= (right as RubyString).value ? TRUE : FALSE;
        case ">=": return left.value >= (right as RubyString).value ? TRUE : FALSE;
        case "<<": return { type:"string", value:left.value + rubyToS(right) };
        case "=~": {
          const m = left.value.match(new RegExp(rubyToS(right)));
          return m ? { type:"int", value:m.index ?? 0 } : NIL;
        }
      }
    }
    // array
    if (left.type === "array") {
      if (op === "+") return { type:"array", elements:[...left.elements, ...(right.type==="array"?right.elements:[right])] };
      if (op === "<<") { left.elements.push(right); return left; }
      if (op === "-" && right.type === "array") return { type:"array", elements:left.elements.filter(e => !right.elements.some(r => rubyEq(e,r))) };
      if (op === "*" && right.type === "int")   return { type:"array", elements:Array(right.value).fill(null).flatMap(()=>[...left.elements]) };
    }
    // equality
    if (op === "==") return rubyEq(left, right) ? TRUE : FALSE;
    if (op === "!=") return rubyEq(left, right) ? FALSE : TRUE;
    // fall through to method call
    return this.callMethod(left, op, [right], undefined, env);
  }

  // ── calls ─────────────────────────────────────────────────────────────────

  evalCall(node: A.Call, env: Env): RubyValue {
    const callee = node.callee;
    const block  = node.block ? this.blockToProc(node.block, env) : undefined;

    if (callee.type === "Ident") {
      const name = callee.name;

      // built-in standalone
      if (name === "puts") {
        if (node.args.length === 0) { this.stdout("\n"); return NIL; }
        for (const a of node.args) {
          const v = this.eval(a, env);
          if (v.type === "array") v.elements.forEach(e => this.stdout(rubyToS(e) + "\n"));
          else this.stdout(rubyToS(v) + "\n");
        }
        return NIL;
      }
      if (name === "print") {
        for (const a of node.args) this.stdout(rubyToS(this.eval(a, env)));
        return NIL;
      }
      if (name === "p") {
        for (const a of node.args) { const v = this.eval(a, env); this.stdout(rubyInspect(v) + "\n"); return v; }
        return NIL;
      }
      if (name === "pp") {
        for (const a of node.args) this.stdout(rubyInspect(this.eval(a, env)) + "\n");
        return NIL;
      }
      if (name === "rand") {
        const arg = node.args[0] ? this.eval(node.args[0], env) : NIL;
        if (arg.type === "int") return { type:"int", value:Math.floor(Math.random() * arg.value) };
        return { type:"float", value:Math.random() };
      }
      if (name === "raise") {
        const msg = node.args[0] ? rubyToS(this.eval(node.args[0], env)) : "RuntimeError";
        throw new Error(msg);
      }
      if (name === "sleep") { return NIL; } // no-op in TS

      // check env for lambda/proc
      const val = env.get(name);
      if (val && val.type === "proc") {
        const args = node.args.map(a => this.eval(a, env));
        return this.callProc(val, args, env, block);
      }

      // class constructor call e.g. Hash.new or Array.new
      const cls = this.classes.get(name);
      if (cls) {
        const args = node.args.map(a => this.eval(a, env));
        return this.instantiate(cls, args, block);
      }

      // method on self
      const self_ = env.get("__self");
      if (self_ && self_.type === "object") {
        const args = node.args.map(a => this.eval(a, env));
        return this.callMethod(self_, name, args, block, env);
      }

      throw new Error(`Undefined method or variable: ${name}`);
    }

    if (callee.type === "Const") {
      const cls = this.classes.get(callee.name);
      if (cls) {
        const args = node.args.map(a => this.eval(a, env));
        return this.instantiate(cls, args, block);
      }
    }

    const fn = this.eval(callee, env);
    if (fn.type === "proc") {
      const args = node.args.map(a => this.eval(a, env));
      return this.callProc(fn, args, env, block);
    }
    throw new Error(`Not callable: ${rubyInspect(fn)}`);
  }

  evalMethodCall(node: A.MethodCall, env: Env): RubyValue {
    const obj   = this.eval(node.obj, env);
    if (node.safe && (obj.type === "nil")) return NIL;
    const args  = node.args.map(a => this.eval(a, env));
    const block = node.block ? this.blockToProc(node.block, env) : undefined;
    return this.callMethod(obj, node.method, args, block, env);
  }

  evalSuper(node: A.SuperNode, env: Env): RubyValue {
    const self_ = env.get("__self");
    const methodNameVal = env.get("__method");
    if (!self_ || self_.type !== "object") throw new Error("super outside method");
    const methodName = methodNameVal?.type === "string" ? methodNameVal.value : "initialize";
    const sup = self_.klass.super_;
    if (!sup) throw new Error("No superclass");
    const method = this.findMethod(sup, methodName);
    if (!method) throw new Error(`undefined method ${methodName} on superclass`);
    const args = node.args.length > 0 ? node.args.map(a => this.eval(a, env)) : (env.get("__args") as RubyArray)?.elements ?? [];
    return this.callUserMethod(method, args, self_, env, undefined);
  }

  // ── method dispatch ────────────────────────────────────────────────────────

  callMethod(obj: RubyValue, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env, fromCls?: RubyClass): RubyValue {
    switch (obj.type) {
      case "int":    return this.intMethod(obj, name, args, block, env);
      case "float":  return this.floatMethod(obj, name, args, block, env);
      case "string": return this.stringMethod(obj, name, args, block, env);
      case "symbol": return this.symbolMethod(obj, name, args, block, env);
      case "array":  return this.arrayMethod(obj, name, args, block, env);
      case "hash":   return this.hashMethod(obj, name, args, block, env);
      case "range":  return this.rangeMethod(obj, name, args, block, env);
      case "bool":   return this.boolMethod(obj, name, args, block, env);
      case "nil":    return this.nilMethod(obj, name, args, block, env);
      case "proc":   return this.procMethod(obj, name, args, block, env);
      case "class":  return this.classMethod(obj, name, args, block, env);
      case "module": return this.moduleMethod(obj, name, args, block, env);
      case "object": return this.objectMethod(obj, name, args, block, env, fromCls);
    }
    throw new Error(`undefined method '${name}' for ${rubyInspect(obj)}`);
  }

  findMethod(cls: RubyClass, name: string): RubyProc | undefined {
    let c: RubyClass | undefined = cls;
    while (c) {
      if (c.methods.has(name)) return c.methods.get(name);
      for (const mod of c.modules) if (mod.methods.has(name)) return mod.methods.get(name);
      c = c.super_;
    }
    return undefined;
  }

  instantiate(cls: RubyClass, args: RubyValue[], block?: RubyProc): RubyValue {
    const obj: RubyObject = { type:"object", klass:cls, ivars:new Map() };
    const ctor = this.findMethod(cls, "initialize");
    if (ctor) this.callUserMethod(ctor, args, obj, this.globalEnv, block);
    return obj;
  }

  objectMethod(obj: RubyObject, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env, fromCls?: RubyClass): RubyValue {
    // core object methods
    if (name === "class")   return { type:"string", value:obj.klass.name };
    if (name === "inspect") return { type:"string", value:rubyInspect(obj) };
    if (name === "to_s")    return { type:"string", value:rubyInspect(obj) };
    if (name === "nil?")    return FALSE;
    if (name === "respond_to?") {
      const m = args[0]?.type === "symbol" ? (args[0] as RubySymbol).name : rubyToS(args[0]);
      return this.findMethod(obj.klass, m) ? TRUE : FALSE;
    }
    if (name === "send") {
      const mname = args[0]?.type === "symbol" ? (args[0] as RubySymbol).name : rubyToS(args[0]);
      return this.callMethod(obj, mname, args.slice(1), block, env);
    }
    if (name === "==" || name === "equal?") return obj === args[0] ? TRUE : FALSE;
    if (name === "!=") return obj !== args[0] ? TRUE : FALSE;

    const method = this.findMethod(fromCls ?? obj.klass, name);
    if (method) return this.callUserMethod(method, args, obj, env, block);

    throw new Error(`undefined method '${name}' for #<${obj.klass.name}>`);
  }

  callUserMethod(proc: RubyProc, args: RubyValue[], self_: RubyValue, callerEnv: Env, block?: RubyProc): RubyValue {
    // attr reader/writer shortcuts
    if ((proc as any)._attrReader) {
      const n = (proc as any)._attrReader as string;
      if (self_.type === "object") return self_.ivars.get("@" + n) ?? NIL;
      return NIL;
    }
    if ((proc as any)._attrWriter) {
      const n = (proc as any)._attrWriter as string;
      if (self_.type === "object") self_.ivars.set("@" + n, args[0] ?? NIL);
      return args[0] ?? NIL;
    }
    // symbol-to-proc
    if ((proc as any)._symProc) {
      const mname = (proc as any)._symProc as string;
      return this.callMethod(args[0], mname, [], undefined, callerEnv);
    }

    const env = new Env(proc.closure);
    env.setLocal("__self", self_);
    env.setLocal("__args", { type:"array", elements:args });
    // bind method name if available
    if ((proc as any)._name) env.setLocal("__method", { type:"string", value:(proc as any)._name });
    if (block) env.setLocal("__block", block);

    // bind params
    let ai = 0;
    for (let pi = 0; pi < proc.params.length; pi++) {
      const pname = proc.params[pi];
      if (pname.startsWith("*")) {
        const rest = args.slice(ai, args.length - (proc.params.length - pi - 1));
        env.setLocal(pname.slice(1) || "_splat", { type:"array", elements:rest });
        ai += rest.length;
      } else {
        env.setLocal(pname, args[ai++] ?? NIL);
      }
    }

    try {
      return this.evalBody(proc.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  callProc(proc: RubyProc, args: RubyValue[], env: Env, block?: RubyProc): RubyValue {
    const self_ = env.get("__self") ?? NIL;
    return this.callUserMethod(proc, args, self_, env, block ?? (env.get("__block") as RubyProc | undefined));
  }

  blockToProc(block: A.BlockNode, env: Env): RubyProc {
    return { type:"proc", params:block.params, body:block.body, closure:env };
  }

  classMethod(cls: RubyClass, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    if (name === "new") return this.instantiate(cls, args, block);
    if (name === "name" || name === "to_s") return { type:"string", value:cls.name };
    const cm = cls.classMethods.get(name);
    if (cm) return this.callUserMethod(cm, args, cls as RubyValue, env, block);
    throw new Error(`undefined class method '${name}' for ${cls.name}`);
  }

  moduleMethod(mod: RubyModule, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    if (name === "name" || name === "to_s") return { type:"string", value:mod.name };
    const m = mod.methods.get(name);
    if (m) return this.callUserMethod(m, args, mod as RubyValue, env, block);
    throw new Error(`undefined method '${name}' for ${mod.name}`);
  }

  procMethod(proc: RubyProc, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    if (name === "call" || name === "===") return this.callProc(proc, args, env, block);
    if (name === "[]") return this.callProc(proc, args, env, block);
    throw new Error(`undefined method '${name}' for Proc`);
  }

  // ── core type methods ──────────────────────────────────────────────────────

  intMethod(obj: RubyInt, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    const a0 = args[0];
    switch (name) {
      case "to_s":    return { type:"string", value:obj.value.toString(a0?.type==="int"?a0.value:10) };
      case "to_i":    return obj;
      case "to_f":    return { type:"float", value:obj.value };
      case "inspect": return { type:"string", value:String(obj.value) };
      case "abs":     return { type:"int", value:Math.abs(obj.value) };
      case "even?":   return obj.value % 2 === 0 ? TRUE : FALSE;
      case "odd?":    return obj.value % 2 !== 0 ? TRUE : FALSE;
      case "zero?":   return obj.value === 0 ? TRUE : FALSE;
      case "nil?":    return FALSE;
      case "times": {
        if (!block) return { type:"array", elements:Array.from({length:obj.value},(_,i)=>({type:"int",value:i} as RubyValue)) };
        let result: RubyValue = NIL;
        for (let i = 0; i < obj.value; i++) {
          try { result = this.callProc(block, [{ type:"int", value:i }], env); }
          catch (e) { if (e instanceof BreakSignal) return e.value; throw e; }
        }
        return result;
      }
      case "upto": {
        const max = (a0 as RubyInt).value;
        if (!block) return NIL;
        for (let i = obj.value; i <= max; i++) {
          try { this.callProc(block, [{ type:"int", value:i }], env); }
          catch (e) { if (e instanceof BreakSignal) return NIL; throw e; }
        }
        return obj;
      }
      case "downto": {
        const min = (a0 as RubyInt).value;
        if (!block) return NIL;
        for (let i = obj.value; i >= min; i--) {
          try { this.callProc(block, [{ type:"int", value:i }], env); }
          catch (e) { if (e instanceof BreakSignal) return NIL; throw e; }
        }
        return obj;
      }
      case "chr":     return { type:"string", value:String.fromCharCode(obj.value) };
      case "floor":   return obj;
      case "ceil":    return obj;
      case "round":   return obj;
      case "+":  case "-": case "*": case "/": case "%": case "**":
      case "==": case "!=": case "<": case ">": case "<=": case ">=": case "<=>":
        return this.applyOp(name, obj, a0!, env);
    }
    throw new Error(`undefined method '${name}' for Integer`);
  }

  floatMethod(obj: RubyFloat, name: string, args: RubyValue[], block: RubyProc | undefined, _env: Env): RubyValue {
    switch (name) {
      case "to_s":    return { type:"string", value:String(obj.value) };
      case "to_i":    return { type:"int", value:Math.trunc(obj.value) };
      case "to_f":    return obj;
      case "inspect": return { type:"string", value:String(obj.value) };
      case "abs":     return { type:"float", value:Math.abs(obj.value) };
      case "ceil":    return { type:"int", value:Math.ceil(obj.value) };
      case "floor":   return { type:"int", value:Math.floor(obj.value) };
      case "round":   return { type:"int", value:Math.round(obj.value) };
      case "zero?":   return obj.value === 0 ? TRUE : FALSE;
      case "nil?":    return FALSE;
      case "nan?":    return isNaN(obj.value) ? TRUE : FALSE;
      case "infinite?": return obj.value === Infinity ? { type:"int",value:1 } : obj.value === -Infinity ? { type:"int",value:-1 } : NIL;
    }
    throw new Error(`undefined method '${name}' for Float`);
  }

  stringMethod(obj: RubyString, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    const s = obj.value;
    const a0 = args[0];
    switch (name) {
      case "to_s": case "to_str": return obj;
      case "to_i":  return { type:"int",   value:parseInt(s, 10) || 0 };
      case "to_f":  return { type:"float", value:parseFloat(s) || 0 };
      case "to_sym": return { type:"symbol", name:s };
      case "inspect": return { type:"string", value:JSON.stringify(s) };
      case "length": case "size": return { type:"int", value:s.length };
      case "empty?": return s.length === 0 ? TRUE : FALSE;
      case "nil?":   return FALSE;
      case "upcase":   return { type:"string", value:s.toUpperCase() };
      case "downcase": return { type:"string", value:s.toLowerCase() };
      case "capitalize": return { type:"string", value:s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() };
      case "strip":  return { type:"string", value:s.trim() };
      case "lstrip": return { type:"string", value:s.trimStart() };
      case "rstrip": return { type:"string", value:s.trimEnd() };
      case "reverse": return { type:"string", value:s.split("").reverse().join("") };
      case "chomp":  return { type:"string", value:s.replace(/\r?\n$/, "") };
      case "chop":   return { type:"string", value:s.slice(0, -1) };
      case "chars":  return { type:"array", elements:s.split("").map(c => ({ type:"string", value:c } as RubyValue)) };
      case "bytes":  return { type:"array", elements:[...Buffer.from(s,"utf8")].map(b => ({ type:"int", value:b } as RubyValue)) };
      case "lines":  return { type:"array", elements:s.split("\n").map(l => ({ type:"string", value:l+"\n" } as RubyValue)) };
      case "split": {
        const sep = a0 ? rubyToS(a0) : " ";
        const parts = sep === "" ? s.split("") : s.split(sep);
        return { type:"array", elements:parts.map(p => ({ type:"string", value:p } as RubyValue)) };
      }
      case "join": {
        if (obj.type === "string") return obj; // called on string itself — no-op
        return obj;
      }
      case "include?": return s.includes(rubyToS(a0 ?? NIL)) ? TRUE : FALSE;
      case "start_with?": return s.startsWith(rubyToS(a0 ?? NIL)) ? TRUE : FALSE;
      case "end_with?":   return s.endsWith(rubyToS(a0 ?? NIL)) ? TRUE : FALSE;
      case "index": {
        const idx = s.indexOf(rubyToS(a0 ?? NIL));
        return idx < 0 ? NIL : { type:"int", value:idx };
      }
      case "sub": {
        const pat = rubyToS(a0 ?? NIL);
        const rep = rubyToS(args[1] ?? NIL);
        return { type:"string", value:s.replace(new RegExp(pat), rep) };
      }
      case "gsub": {
        if (block && a0) {
          const pat = new RegExp(rubyToS(a0), "g");
          const result = s.replace(pat, m => rubyToS(this.callProc(block, [{ type:"string", value:m }], env)));
          return { type:"string", value:result };
        }
        const pat = rubyToS(a0 ?? NIL);
        const rep = rubyToS(args[1] ?? NIL);
        return { type:"string", value:s.replace(new RegExp(pat, "g"), rep) };
      }
      case "match": case "match?": {
        const m = s.match(new RegExp(rubyToS(a0 ?? NIL)));
        return m ? TRUE : (name === "match?" ? FALSE : NIL);
      }
      case "=~": {
        const m = s.match(new RegExp(rubyToS(a0 ?? NIL)));
        return m ? { type:"int", value:m.index ?? 0 } : NIL;
      }
      case "tr": {
        // simplified tr
        const from = rubyToS(a0 ?? NIL), to = rubyToS(args[1] ?? NIL);
        let result = s;
        for (let i = 0; i < from.length; i++) result = result.split(from[i]).join(to[i] ?? to[to.length-1] ?? "");
        return { type:"string", value:result };
      }
      case "count": return { type:"int", value:s.split(rubyToS(a0 ?? NIL)).length - 1 };
      case "[]": {
        if (a0?.type === "int") { const c = s[a0.value < 0 ? s.length + a0.value : a0.value]; return c ? { type:"string", value:c } : NIL; }
        if (a0?.type === "range") { const from = a0.from, to = a0.exclusive ? a0.to : a0.to+1; return { type:"string", value:s.slice(from, to) }; }
        return NIL;
      }
      case "<<": { (obj as any).value += rubyToS(a0 ?? NIL); return obj; }
      case "+": return { type:"string", value:s + rubyToS(a0 ?? NIL) };
      case "*": return { type:"string", value:s.repeat((a0 as RubyInt)?.value ?? 0) };
      case "==": return s === (a0 as RubyString)?.value ? TRUE : FALSE;
      case "!=": return s !== (a0 as RubyString)?.value ? TRUE : FALSE;
      case "<":  return s <  rubyToS(a0 ?? NIL) ? TRUE : FALSE;
      case ">":  return s >  rubyToS(a0 ?? NIL) ? TRUE : FALSE;
      case "<=": return s <= rubyToS(a0 ?? NIL) ? TRUE : FALSE;
      case ">=": return s >= rubyToS(a0 ?? NIL) ? TRUE : FALSE;
      case "<=>": { const b = rubyToS(a0??NIL); return { type:"int", value:s<b?-1:s>b?1:0 }; }
      case "freeze": return obj;
      case "dup": case "clone": return { type:"string", value:s };
      case "each_char": {
        if (!block) return obj;
        for (const c of s) this.callProc(block, [{ type:"string", value:c }], env);
        return obj;
      }
      case "each_line": {
        if (!block) return obj;
        for (const l of s.split("\n")) this.callProc(block, [{ type:"string", value:l+"\n" }], env);
        return obj;
      }
      case "scan": {
        const re = new RegExp(rubyToS(a0 ?? NIL), "g");
        const results: RubyValue[] = [];
        let m; while ((m = re.exec(s)) !== null) results.push({ type:"string", value:m[0] });
        return { type:"array", elements:results };
      }
      case "format": case "%": {
        // simple sprintf
        return { type:"string", value:s };
      }
    }
    throw new Error(`undefined method '${name}' for String`);
  }

  symbolMethod(obj: RubySymbol, name: string, args: RubyValue[], _block: RubyProc | undefined, env: Env): RubyValue {
    switch (name) {
      case "to_s": case "id2name": return { type:"string", value:obj.name };
      case "to_sym": return obj;
      case "inspect": return { type:"string", value:`:${obj.name}` };
      case "==": return obj.name === (args[0] as RubySymbol)?.name ? TRUE : FALSE;
      case "to_proc": return { type:"proc", params:["__it"], body:[], closure:env, _symProc:obj.name } as any;
    }
    throw new Error(`undefined method '${name}' for Symbol`);
  }

  boolMethod(obj: RubyBool, name: string, _args: RubyValue[], _b: RubyProc | undefined, _e: Env): RubyValue {
    switch (name) {
      case "to_s":    return { type:"string", value:String(obj.value) };
      case "inspect": return { type:"string", value:String(obj.value) };
      case "!":       return obj.value ? FALSE : TRUE;
      case "nil?":    return FALSE;
      case "==": return rubyEq(obj, _args[0]) ? TRUE : FALSE;
    }
    throw new Error(`undefined method '${name}' for ${obj.value ? "true" : "false"}`);
  }

  nilMethod(_obj: RubyNil, name: string, _args: RubyValue[], _b: RubyProc | undefined, _e: Env): RubyValue {
    switch (name) {
      case "to_s":    return { type:"string", value:"" };
      case "to_a":    return { type:"array", elements:[] };
      case "to_i":    return { type:"int", value:0 };
      case "inspect": return { type:"string", value:"nil" };
      case "nil?":    return TRUE;
      case "!":       return TRUE;
      case "==": return _args[0]?.type === "nil" ? TRUE : FALSE;
    }
    throw new Error(`undefined method '${name}' for nil`);
  }

  arrayMethod(obj: RubyArray, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    const arr = obj.elements;
    const a0  = args[0];
    switch (name) {
      case "length": case "size": case "count": return { type:"int", value:arr.length };
      case "empty?": return arr.length === 0 ? TRUE : FALSE;
      case "nil?":   return FALSE;
      case "first":  return arr[0] ?? NIL;
      case "last":   return arr[arr.length - 1] ?? NIL;
      case "push": case "append": case "<<": { arr.push(...args); return obj; }
      case "pop":   { const v = arr.pop(); return v ?? NIL; }
      case "shift": { const v = arr.shift(); return v ?? NIL; }
      case "unshift": { arr.unshift(...args); return obj; }
      case "flatten": {
        const flat = (a: RubyValue[]): RubyValue[] => a.flatMap(e => e.type==="array" ? flat(e.elements) : [e]);
        return { type:"array", elements:flat(arr) };
      }
      case "compact": return { type:"array", elements:arr.filter(e => e.type !== "nil") };
      case "uniq": {
        const seen = new Set<string>();
        return { type:"array", elements:arr.filter(e => { const k = rubyInspect(e); if (seen.has(k)) return false; seen.add(k); return true; }) };
      }
      case "reverse": return { type:"array", elements:[...arr].reverse() };
      case "sort": {
        const sorted = [...arr];
        if (block) sorted.sort((a,b) => { const r = this.callProc(block,[a,b],env); return r.type==="int"?r.value:0; });
        else sorted.sort((a,b) => { const r = this.applyOp("<=>",a,b,env); return r.type==="int"?r.value:0; });
        return { type:"array", elements:sorted };
      }
      case "sort_by": {
        if (!block) return obj;
        const sorted = [...arr].sort((a,b) => {
          const ka = this.callProc(block,[a],env), kb = this.callProc(block,[b],env);
          const r = this.applyOp("<=>",ka,kb,env);
          return r.type==="int" ? r.value : 0;
        });
        return { type:"array", elements:sorted };
      }
      case "include?": return arr.some(e => rubyEq(e, a0!)) ? TRUE : FALSE;
      case "join": {
        const sep = a0 ? rubyToS(a0) : "";
        return { type:"string", value:arr.map(rubyToS).join(sep) };
      }
      case "each": {
        if (!block) return obj;
        try {
          for (const e of arr) {
            try { this.callProc(block, [e], env); }
            catch (e2) { if (e2 instanceof NextSignal) continue; throw e2; }
          }
        } catch(e) { if (e instanceof BreakSignal) return e.value; throw e; }
        return obj;
      }
      case "each_with_index": {
        if (!block) return obj;
        arr.forEach((e,i) => { try { this.callProc(block,[e,{type:"int",value:i}],env); } catch(e2){ if(!(e2 instanceof NextSignal)) throw e2; } });
        return obj;
      }
      case "each_with_object": {
        if (!block || !a0) return obj;
        arr.forEach(e => { try { this.callProc(block,[e,a0],env); } catch(e2){ if(!(e2 instanceof NextSignal)) throw e2; } });
        return a0;
      }
      case "map": case "collect": {
        if (!block) return obj;
        const results: RubyValue[] = [];
        for (const e of arr) {
          try { results.push(this.callProc(block, [e], env)); }
          catch (e2) { if (e2 instanceof NextSignal) { results.push(NIL); continue; } throw e2; }
        }
        return { type:"array", elements:results };
      }
      case "flat_map": {
        if (!block) return obj;
        const results: RubyValue[] = [];
        for (const e of arr) {
          const r = this.callProc(block,[e],env);
          if (r.type === "array") results.push(...r.elements); else results.push(r);
        }
        return { type:"array", elements:results };
      }
      case "filter": case "select": {
        if (!block) return obj;
        return { type:"array", elements:arr.filter(e => isTruthy(this.callProc(block,[e],env))) };
      }
      case "reject": {
        if (!block) return obj;
        return { type:"array", elements:arr.filter(e => !isTruthy(this.callProc(block,[e],env))) };
      }
      case "reduce": case "inject": {
        let acc: RubyValue, start = 0;
        if (a0 && !block) { // inject(:+) form
          const op = a0.type === "symbol" ? a0.name : rubyToS(a0);
          return arr.slice(1).reduce((acc,e) => this.applyOp(op,acc,e,env), arr[0] ?? NIL);
        }
        if (a0 && block) { acc = a0; start = 0; } else { acc = arr[0]; start = 1; }
        for (let i = start; i < arr.length; i++) acc = this.callProc(block!,[acc,arr[i]],env);
        return acc ?? NIL;
      }
      case "find": case "detect": {
        if (!block) return NIL;
        return arr.find(e => isTruthy(this.callProc(block,[e],env))) ?? NIL;
      }
      case "all?": {
        if (!block) return arr.every(isTruthy) ? TRUE : FALSE;
        return arr.every(e => isTruthy(this.callProc(block,[e],env))) ? TRUE : FALSE;
      }
      case "any?": {
        if (!block) return arr.some(isTruthy) ? TRUE : FALSE;
        return arr.some(e => isTruthy(this.callProc(block,[e],env))) ? TRUE : FALSE;
      }
      case "none?": {
        if (!block) return arr.every(e => !isTruthy(e)) ? TRUE : FALSE;
        return arr.every(e => !isTruthy(this.callProc(block,[e],env))) ? TRUE : FALSE;
      }
      case "min": {
        if (!block && arr.length === 0) return NIL;
        return arr.reduce((m,e) => { const r = this.applyOp("<=>",e,m,env); return r.type==="int"&&r.value<0 ? e : m; });
      }
      case "max": {
        if (!block && arr.length === 0) return NIL;
        return arr.reduce((m,e) => { const r = this.applyOp("<=>",e,m,env); return r.type==="int"&&r.value>0 ? e : m; });
      }
      case "min_by": {
        if (!block || arr.length === 0) return NIL;
        return arr.reduce((m,e) => {
          const km = this.callProc(block,[m],env), ke = this.callProc(block,[e],env);
          const r = this.applyOp("<=>",ke,km,env);
          return r.type==="int"&&r.value<0 ? e : m;
        });
      }
      case "max_by": {
        if (!block || arr.length === 0) return NIL;
        return arr.reduce((m,e) => {
          const km = this.callProc(block,[m],env), ke = this.callProc(block,[e],env);
          const r = this.applyOp("<=>",ke,km,env);
          return r.type==="int"&&r.value>0 ? e : m;
        });
      }
      case "sum": {
        if (block) return arr.map(e => this.callProc(block,[e],env)).reduce((a,e) => this.applyOp("+",a,e,env), { type:"int", value:0 } as RubyValue);
        return arr.reduce((a,e) => this.applyOp("+",a,e,env), a0 ?? { type:"int", value:0 } as RubyValue);
      }
      case "zip": {
        const others = args.map(a => a.type==="array" ? a.elements : [a]);
        return { type:"array", elements:arr.map((e,i) => ({ type:"array", elements:[e,...others.map(o=>o[i]??NIL)] } as RubyValue)) };
      }
      case "product": {
        const other = (a0 as RubyArray)?.elements ?? [];
        const pairs: RubyValue[] = [];
        for (const e of arr) for (const f of other) pairs.push({ type:"array", elements:[e,f] });
        return { type:"array", elements:pairs };
      }
      case "combination": {
        const n = (a0 as RubyInt).value;
        const combos = combinations(arr, n);
        if (!block) return { type:"array", elements:combos.map(c=>({ type:"array", elements:c } as RubyValue)) };
        for (const c of combos) this.callProc(block,[{ type:"array", elements:c }],env);
        return obj;
      }
      case "permutation": {
        const n = a0 ? (a0 as RubyInt).value : arr.length;
        const perms = permutations(arr, n);
        if (!block) return { type:"array", elements:perms.map(p=>({ type:"array", elements:p } as RubyValue)) };
        for (const p of perms) this.callProc(block,[{ type:"array", elements:p }],env);
        return obj;
      }
      case "take":    return { type:"array", elements:arr.slice(0, (a0 as RubyInt).value) };
      case "drop":    return { type:"array", elements:arr.slice((a0 as RubyInt).value) };
      case "take_while": {
        if (!block) return obj;
        const res: RubyValue[] = [];
        for (const e of arr) { if (!isTruthy(this.callProc(block,[e],env))) break; res.push(e); }
        return { type:"array", elements:res };
      }
      case "drop_while": {
        if (!block) return obj;
        let dropping = true;
        const res: RubyValue[] = [];
        for (const e of arr) { if (dropping && isTruthy(this.callProc(block,[e],env))) continue; dropping = false; res.push(e); }
        return { type:"array", elements:res };
      }
      case "group_by": {
        if (!block) return NIL;
        const map = new Map<string, RubyValue>(), keys: RubyValue[] = [];
        for (const e of arr) {
          const k = this.callProc(block,[e],env), hk = hashKey(k);
          if (!map.has(hk)) { keys.push(k); map.set(hk, { type:"array", elements:[] }); }
          ((map.get(hk) as RubyArray).elements).push(e);
        }
        return { type:"hash", map, keys };
      }
      case "tally": {
        const map = new Map<string,RubyValue>(), keys: RubyValue[] = [];
        for (const e of arr) {
          const hk = hashKey(e);
          if (!map.has(hk)) { keys.push(e); map.set(hk, { type:"int", value:0 }); }
          (map.get(hk) as RubyInt).value++;
        }
        return { type:"hash", map, keys };
      }
      case "chunk": {
        if (!block) return NIL;
        const chunks: RubyValue[] = [];
        let curKey: string | null = null, curArr: RubyValue[] = [];
        for (const e of arr) {
          const k = this.callProc(block,[e],env), hk = hashKey(k);
          if (hk !== curKey) { if (curArr.length) chunks.push({ type:"array", elements:[JSON.parse(curKey ?? "null") as RubyValue, { type:"array", elements:curArr }] }); curKey = hk; curArr = []; }
          curArr.push(e);
        }
        if (curArr.length) chunks.push({ type:"array", elements:[{ type:"string", value:curKey ?? "" }, { type:"array", elements:curArr }] });
        return { type:"array", elements:chunks };
      }
      case "flatten!": { const flat = (a: RubyValue[]): RubyValue[] => a.flatMap(e => e.type==="array" ? flat(e.elements) : [e]); obj.elements = flat(arr); return obj; }
      case "map!": case "collect!": {
        if (!block) return obj;
        obj.elements = arr.map(e => this.callProc(block,[e],env));
        return obj;
      }
      case "delete": {
        const before = arr.length;
        obj.elements = arr.filter(e => !rubyEq(e,a0!));
        return arr.length < before ? a0! : NIL;
      }
      case "delete_if": {
        if (!block) return obj;
        obj.elements = arr.filter(e => !isTruthy(this.callProc(block,[e],env)));
        return obj;
      }
      case "index": case "find_index": {
        if (block) { const i = arr.findIndex(e => isTruthy(this.callProc(block,[e],env))); return i<0?NIL:{type:"int",value:i}; }
        const i = arr.findIndex(e => rubyEq(e,a0!));
        return i<0 ? NIL : { type:"int", value:i };
      }
      case "[]": {
        if (a0?.type === "int") { const idx = a0.value < 0 ? arr.length+a0.value : a0.value; return arr[idx] ?? NIL; }
        if (a0?.type === "range") { return { type:"array", elements:arr.slice(a0.from, a0.exclusive ? a0.to : a0.to+1) }; }
        return NIL;
      }
      case "[]=": { const idx = (a0 as RubyInt).value; arr[idx<0?arr.length+idx:idx] = args[1]!; return args[1]!; }
      case "to_s": case "inspect": return { type:"string", value:rubyInspect(obj) };
      case "to_a": return obj;
      case "+": return { type:"array", elements:[...arr,...(a0 as RubyArray).elements] };
      case "-": return { type:"array", elements:arr.filter(e=>!(a0 as RubyArray).elements.some(r=>rubyEq(e,r))) };
      case "*": return a0?.type==="int" ? { type:"array", elements:Array(a0.value).fill(null).flatMap(()=>[...arr]) } : { type:"string", value:arr.map(rubyToS).join(rubyToS(a0!)) };
      case "&": return { type:"array", elements:arr.filter(e=>(a0 as RubyArray).elements.some(r=>rubyEq(e,r))) };
      case "|": {
        const res = [...arr];
        for (const e of (a0 as RubyArray).elements) if (!res.some(r=>rubyEq(r,e))) res.push(e);
        return { type:"array", elements:res };
      }
      case "<<": { arr.push(a0!); return obj; }
      case "concat": { arr.push(...(a0 as RubyArray).elements); return obj; }
      case "sample": { return arr[Math.floor(Math.random()*arr.length)] ?? NIL; }
      case "shuffle": { return { type:"array", elements:[...arr].sort(()=>Math.random()-.5) }; }
      case "rotate": { const n=(a0 as RubyInt|undefined)?.value??1; return { type:"array", elements:[...arr.slice(n),...arr.slice(0,n)] }; }
      case "each_slice": {
        const n = (a0 as RubyInt).value;
        const slices: RubyValue[] = [];
        for (let i=0;i<arr.length;i+=n) slices.push({ type:"array", elements:arr.slice(i,i+n) });
        if (!block) return { type:"array", elements:slices };
        for (const s of slices) this.callProc(block,[s],env);
        return NIL;
      }
      case "each_cons": {
        const n = (a0 as RubyInt).value;
        if (!block) return NIL;
        for (let i=0;i<=arr.length-n;i++) this.callProc(block,[{ type:"array", elements:arr.slice(i,i+n) }],env);
        return NIL;
      }
      case "zip": {
        const others = args.map(a=>a.type==="array"?a.elements:[a]);
        return { type:"array", elements:arr.map((e,i)=>({ type:"array", elements:[e,...others.map(o=>o[i]??NIL)] } as RubyValue)) };
      }
    }
    throw new Error(`undefined method '${name}' for Array`);
  }

  hashMethod(obj: RubyHash, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    const { map, keys } = obj;
    const a0 = args[0];
    switch (name) {
      case "[]":    { const hk = hashKey(a0!); return map.get(hk) ?? NIL; }
      case "[]=": {
        const hk = hashKey(a0!);
        if (!map.has(hk)) keys.push(a0!);
        map.set(hk, args[1]!);
        return args[1]!;
      }
      case "length": case "size": case "count": return { type:"int", value:keys.length };
      case "empty?": return keys.length === 0 ? TRUE : FALSE;
      case "nil?":   return FALSE;
      case "has_key?": case "key?": case "include?": case "member?": return map.has(hashKey(a0!)) ? TRUE : FALSE;
      case "has_value?": case "value?": return [...map.values()].some(v=>rubyEq(v,a0!)) ? TRUE : FALSE;
      case "keys":   return { type:"array", elements:[...keys] };
      case "values": return { type:"array", elements:keys.map(k=>map.get(hashKey(k))!) };
      case "to_a":   return { type:"array", elements:keys.map(k=>({ type:"array", elements:[k, map.get(hashKey(k))!] } as RubyValue)) };
      case "each": case "each_pair": {
        if (!block) return obj;
        for (const k of keys) {
          try { this.callProc(block,[k, map.get(hashKey(k))!],env); }
          catch(e) { if(e instanceof NextSignal) continue; throw e; }
        }
        return obj;
      }
      case "each_key": {
        if (!block) return obj;
        for (const k of keys) this.callProc(block,[k],env);
        return obj;
      }
      case "each_value": {
        if (!block) return obj;
        for (const k of keys) this.callProc(block,[map.get(hashKey(k))!],env);
        return obj;
      }
      case "map": case "collect": {
        if (!block) return obj;
        const results: RubyValue[] = keys.map(k => this.callProc(block,[k,map.get(hashKey(k))!],env));
        return { type:"array", elements:results };
      }
      case "select": case "filter": {
        if (!block) return obj;
        const nm = new Map<string,RubyValue>(), nk: RubyValue[] = [];
        for (const k of keys) { const v=map.get(hashKey(k))!; if (isTruthy(this.callProc(block,[k,v],env))) { nm.set(hashKey(k),v); nk.push(k); } }
        return { type:"hash", map:nm, keys:nk };
      }
      case "reject": {
        if (!block) return obj;
        const nm = new Map<string,RubyValue>(), nk: RubyValue[] = [];
        for (const k of keys) { const v=map.get(hashKey(k))!; if (!isTruthy(this.callProc(block,[k,v],env))) { nm.set(hashKey(k),v); nk.push(k); } }
        return { type:"hash", map:nm, keys:nk };
      }
      case "any?": {
        if (!block) return keys.length > 0 ? TRUE : FALSE;
        return keys.some(k => isTruthy(this.callProc(block,[k,map.get(hashKey(k))!],env))) ? TRUE : FALSE;
      }
      case "all?": {
        if (!block) return keys.every(k => isTruthy(map.get(hashKey(k))!)) ? TRUE : FALSE;
        return keys.every(k => isTruthy(this.callProc(block,[k,map.get(hashKey(k))!],env))) ? TRUE : FALSE;
      }
      case "merge": {
        const other = a0 as RubyHash;
        const nm = new Map(map), nk = [...keys];
        for (const k of other.keys) { const hk=hashKey(k); if(!nm.has(hk)) nk.push(k); nm.set(hk,other.map.get(hk)!); }
        return { type:"hash", map:nm, keys:nk };
      }
      case "merge!": case "update": {
        const other = a0 as RubyHash;
        for (const k of other.keys) { const hk=hashKey(k); if(!map.has(hk)) keys.push(k); map.set(hk,other.map.get(hk)!); }
        return obj;
      }
      case "delete": { const hk=hashKey(a0!); const v=map.get(hk)??NIL; map.delete(hk); obj.keys=keys.filter(k=>hashKey(k)!==hk); return v; }
      case "fetch": {
        const hk=hashKey(a0!); if(map.has(hk)) return map.get(hk)!;
        if (args[1]) return args[1];
        throw new Error(`KeyError: key not found: ${rubyInspect(a0!)}`);
      }
      case "dig": {
        let curr: RubyValue = obj;
        for (const k of args) {
          if (curr.type === "hash") curr = curr.map.get(hashKey(k)) ?? NIL;
          else if (curr.type === "array" && k.type === "int") curr = curr.elements[k.value] ?? NIL;
          else return NIL;
        }
        return curr;
      }
      case "transform_values": {
        if (!block) return obj;
        const nm = new Map<string,RubyValue>(), nk = [...keys];
        for (const k of keys) { const hk=hashKey(k); nm.set(hk, this.callProc(block,[map.get(hk)!],env)); }
        return { type:"hash", map:nm, keys:nk };
      }
      case "transform_keys": {
        if (!block) return obj;
        const nm = new Map<string,RubyValue>(), nk: RubyValue[] = [];
        for (const k of keys) { const nkey=this.callProc(block,[k],env); nk.push(nkey); nm.set(hashKey(nkey),map.get(hashKey(k))!); }
        return { type:"hash", map:nm, keys:nk };
      }
      case "flatten": return { type:"array", elements:keys.flatMap(k=>[k,map.get(hashKey(k))!]) };
      case "invert": {
        const nm = new Map<string,RubyValue>(), nk: RubyValue[] = [];
        for (const k of keys) { const v=map.get(hashKey(k))!; nk.push(v); nm.set(hashKey(v),k); }
        return { type:"hash", map:nm, keys:nk };
      }
      case "to_s": case "inspect": return { type:"string", value:rubyInspect(obj) };
      case "min_by": {
        if (!block || keys.length===0) return NIL;
        const pairs = keys.map(k=>([k,map.get(hashKey(k))!] as [RubyValue,RubyValue]));
        const res = pairs.reduce((m,e)=>{ const km=this.callProc(block,m,env),ke=this.callProc(block,e,env),r=this.applyOp("<=>",ke,km,env); return r.type==="int"&&r.value<0?e:m; });
        return { type:"array", elements:res as unknown as RubyValue[] };
      }
    }
    throw new Error(`undefined method '${name}' for Hash`);
  }

  rangeMethod(obj: RubyRange, name: string, args: RubyValue[], block: RubyProc | undefined, env: Env): RubyValue {
    const { from, to, exclusive } = obj;
    const max = exclusive ? to - 1 : to;
    const arr: number[] = [];
    for (let i = from; i <= max; i++) arr.push(i);

    switch (name) {
      case "each": {
        if (!block) return obj;
        try {
          for (const n of arr) {
            try { this.callProc(block, [{ type:"int", value:n }], env); }
            catch(e) { if(e instanceof NextSignal) continue; throw e; }
          }
        } catch(e) { if(e instanceof BreakSignal) return e.value; throw e; }
        return obj;
      }
      case "map": case "collect": {
        if (!block) return obj;
        return { type:"array", elements:arr.map(n => this.callProc(block,[{type:"int",value:n}],env)) };
      }
      case "select": case "filter": {
        if (!block) return obj;
        const filtered = arr.filter(n => isTruthy(this.callProc(block,[{type:"int",value:n}],env)));
        return { type:"array", elements:filtered.map(n=>({type:"int",value:n} as RubyValue)) };
      }
      case "reject": {
        if (!block) return obj;
        const filtered = arr.filter(n => !isTruthy(this.callProc(block,[{type:"int",value:n}],env)));
        return { type:"array", elements:filtered.map(n=>({type:"int",value:n} as RubyValue)) };
      }
      case "reduce": case "inject": {
        const ints: RubyValue[] = arr.map(n=>({type:"int",value:n} as RubyValue));
        const a0 = args[0];
        if (a0?.type === "symbol") return ints.slice(1).reduce((ac,e)=>this.applyOp((a0 as RubySymbol).name,ac,e,env), ints[0]??NIL);
        let acc: RubyValue = (a0 ?? ints[0]) as RubyValue; const start = a0 ? 0 : 1;
        for (let i=start;i<ints.length;i++) acc = this.callProc(block!,[acc,ints[i]],env);
        return acc ?? NIL;
      }
      case "sum":   return { type:"int", value:arr.reduce((a,b)=>a+b,0) };
      case "min":   return { type:"int", value:Math.min(...arr) };
      case "max":   return { type:"int", value:Math.max(...arr) };
      case "first": return { type:"int", value:from };
      case "last":  return { type:"int", value:max };
      case "count": case "size": case "length": return { type:"int", value:arr.length };
      case "include?": case "cover?": case "===": {
        const v = (args[0] as RubyInt).value;
        return v >= from && (exclusive ? v < to : v <= to) ? TRUE : FALSE;
      }
      case "to_a": return { type:"array", elements:arr.map(n=>({type:"int",value:n} as RubyValue)) };
      case "step": {
        const step = (args[0] as RubyInt)?.value ?? 1;
        if (!block) return obj;
        for (let i=from; i<=max; i+=step) this.callProc(block,[{type:"int",value:i}],env);
        return obj;
      }
      case "each_slice": return this.arrayMethod({ type:"array", elements:arr.map(n=>({type:"int",value:n} as RubyValue)) }, "each_slice", args, block, env);
    }
    throw new Error(`undefined method '${name}' for Range`);
  }

  // ── core class registrations ───────────────────────────────────────────────

  registerCoreClasses() {
    // Kernel-like globals
    this.globalEnv.setLocal("STDOUT",  { type:"object", klass:{ type:"class", name:"IO", super_:undefined, methods:new Map(), classMethods:new Map(), constants:new Map(), modules:[] }, ivars:new Map() });
    this.globalEnv.setLocal("ARGV",    { type:"array", elements:[] });
    this.globalEnv.setLocal("ENV",     { type:"hash", map:new Map(), keys:[] });
    this.globalEnv.setLocal("RUBY_VERSION", { type:"string", value:"3.0.0 (brew-lang)" });

    // Math module
    const mathMod: RubyModule = { type:"module", name:"Math", methods:new Map(), constants:new Map() };
    mathMod.constants.set("PI", { type:"float", value:Math.PI });
    mathMod.constants.set("E",  { type:"float", value:Math.E });
    this.modules.set("Math", mathMod);
    this.globalEnv.setLocal("Math", mathMod as RubyValue);

    // Comparable, Enumerable (stub modules)
    for (const n of ["Comparable","Enumerable"]) {
      const m: RubyModule = { type:"module", name:n, methods:new Map(), constants:new Map() };
      this.modules.set(n, m);
      this.globalEnv.setLocal(n, m as RubyValue);
    }

    // Object base class
    const objectClass: RubyClass = { type:"class", name:"Object", super_:undefined, methods:new Map(), classMethods:new Map(), constants:new Map(), modules:[] };
    this.classes.set("Object", objectClass);
    this.globalEnv.setLocal("Object", objectClass as RubyValue);

    // BasicObject
    const basicObject: RubyClass = { type:"class", name:"BasicObject", super_:undefined, methods:new Map(), classMethods:new Map(), constants:new Map(), modules:[] };
    this.classes.set("BasicObject", basicObject);
    this.globalEnv.setLocal("BasicObject", basicObject as RubyValue);
  }

  // ── utils ──────────────────────────────────────────────────────────────────

  toArray(v: RubyValue): RubyValue[] {
    if (v.type === "array") return v.elements;
    if (v.type === "range") {
      const arr: RubyValue[] = [];
      const max = v.exclusive ? v.to - 1 : v.to;
      for (let i = v.from; i <= max; i++) arr.push({ type:"int", value:i });
      return arr;
    }
    if (v.type === "hash") return v.keys.map(k => ({ type:"array", elements:[k, v.map.get(hashKey(k))!] } as RubyValue));
    return [v];
  }
}

function combinations<T>(arr: T[], n: number): T[][] {
  if (n === 0) return [[]];
  if (n > arr.length) return [];
  const [first, ...rest] = arr;
  return [...combinations(rest, n-1).map(c=>[first,...c]), ...combinations(rest, n)];
}
function permutations<T>(arr: T[], n: number): T[][] {
  if (n === 0) return [[]];
  return arr.flatMap((e,i) => permutations([...arr.slice(0,i),...arr.slice(i+1)], n-1).map(p=>[e,...p]));
}
