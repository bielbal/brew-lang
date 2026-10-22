export type RubyValue =
  | RubyInt | RubyFloat | RubyString | RubySymbol | RubyBool | RubyNil
  | RubyArray | RubyHash | RubyProc | RubyClass | RubyModule | RubyObject
  | RubyRange | RubyReturn | RubyBreak | RubyNext;

export interface RubyInt    { type:"int";    value:number }
export interface RubyFloat  { type:"float";  value:number }
export interface RubyString { type:"string"; value:string }
export interface RubySymbol { type:"symbol"; name:string }
export interface RubyBool   { type:"bool";   value:boolean }
export interface RubyNil    { type:"nil" }
export interface RubyArray  { type:"array";  elements:RubyValue[] }
export interface RubyHash   { type:"hash";   map:Map<string,RubyValue>; keys:RubyValue[] }
export interface RubyRange  { type:"range";  from:number; to:number; exclusive:boolean }

export interface RubyProc {
  type:"proc";
  params: string[];
  body: import("./ast").Node[];
  closure: Env;
  isLambda?: boolean;
}

export interface RubyClass {
  type:"class";
  name:string;
  super_?: RubyClass;
  methods: Map<string, RubyProc>;
  classMethods: Map<string, RubyProc>;
  constants: Map<string, RubyValue>;
  modules: RubyModule[];
}

export interface RubyModule {
  type:"module";
  name:string;
  methods: Map<string, RubyProc>;
  constants: Map<string, RubyValue>;
}

export interface RubyObject {
  type:"object";
  klass: RubyClass;
  ivars: Map<string, RubyValue>;
}

// control flow sentinels
export interface RubyReturn { type:"__return"; value:RubyValue }
export interface RubyBreak  { type:"__break";  value:RubyValue }
export interface RubyNext   { type:"__next";   value:RubyValue }

// ─── environment ──────────────────────────────────────────────────────────────

export class Env {
  vars = new Map<string, RubyValue>();
  constructor(public parent?: Env) {}

  get(name: string): RubyValue {
    if (this.vars.has(name)) return this.vars.get(name)!;
    if (this.parent) return this.parent.get(name);
    return NIL;
  }
  set(name: string, value: RubyValue): void {
    // walk up to find existing binding
    let env: Env | undefined = this;
    while (env) {
      if (env.vars.has(name)) { env.vars.set(name, value); return; }
      env = env.parent;
    }
    this.vars.set(name, value);
  }
  setLocal(name: string, value: RubyValue): void { this.vars.set(name, value); }
  has(name: string): boolean {
    if (this.vars.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }
}

// ─── singletons ───────────────────────────────────────────────────────────────

export const NIL:   RubyNil  = { type:"nil" };
export const TRUE:  RubyBool = { type:"bool", value:true };
export const FALSE: RubyBool = { type:"bool", value:false };

// ─── helpers ──────────────────────────────────────────────────────────────────

export function isTruthy(v: RubyValue): boolean {
  if (v.type === "nil") return false;
  if (v.type === "bool") return v.value;
  return true;
}

export function rubyInspect(v: RubyValue): string {
  switch (v.type) {
    case "nil":    return "nil";
    case "bool":   return String(v.value);
    case "int":    return String(v.value);
    case "float":  return String(v.value);
    case "string": return JSON.stringify(v.value);
    case "symbol": return `:${v.name}`;
    case "array":  return `[${v.elements.map(rubyInspect).join(", ")}]`;
    case "hash": {
      const pairs = v.keys.map(k => `${rubyInspect(k)} => ${rubyInspect(v.map.get(hashKey(k))!)}`);
      return `{${pairs.join(", ")}}`;
    }
    case "range":  return `${v.from}${v.exclusive ? "..." : ".."}${v.to}`;
    case "proc":   return v.isLambda ? "#<Proc (lambda)>" : "#<Proc>";
    case "class":  return v.name;
    case "module": return v.name;
    case "object": return `#<${v.klass.name}>`;
    default: return "?";
  }
}

export function rubyToS(v: RubyValue): string {
  switch (v.type) {
    case "nil":    return "";
    case "bool":   return String(v.value);
    case "string": return v.value;
    default: return rubyInspect(v);
  }
}

export function hashKey(v: RubyValue): string {
  if (v.type === "symbol") return `:${v.name}`;
  if (v.type === "string") return `"${v.value}"`;
  if (v.type === "int")    return `i${v.value}`;
  return rubyInspect(v);
}

export function rubyEq(a: RubyValue, b: RubyValue): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "nil") return true;
  if (a.type === "bool" && b.type === "bool") return a.value === b.value;
  if ((a.type === "int" || a.type === "float") && (b.type === "int" || b.type === "float")) return a.value === b.value;
  if (a.type === "string" && b.type === "string") return a.value === b.value;
  if (a.type === "symbol" && b.type === "symbol") return a.name === b.name;
  return a === b;
}
