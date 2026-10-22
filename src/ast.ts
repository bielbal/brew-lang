export type Node =
  | Program | ClassDef | ModuleDef | MethodDef | SingletonMethodDef
  | BlockNode | LambdaNode
  | IfNode | UnlessNode | WhileNode | UntilNode | ForIn | CaseNode
  | ReturnNode | YieldNode | RaiseNode | BreakNode | NextNode
  | BeginRescue
  | Assign | OpAssign | MultiAssign
  | BinOp | UnaryOp
  | Call | MethodCall | IndexGet | IndexSet | RangeNode
  | ArrayLit | HashLit
  | Ident | IVar | CVar | GVar | Const | SelfNode | SuperNode
  | IntLit | FloatLit | StrLit | InterpolatedStr | SymLit | BoolLit | NilLit
  | ExprStmt;

export interface Program            { type:"Program";            body:Node[] }
export interface ClassDef           { type:"ClassDef";           name:string; super_?:string; body:Node[] }
export interface ModuleDef          { type:"ModuleDef";          name:string; body:Node[] }
export interface MethodDef          { type:"MethodDef";          name:string; params:Param[]; body:Node[] }
export interface SingletonMethodDef { type:"SingletonMethodDef"; obj:Node; name:string; params:Param[]; body:Node[] }
export interface Param              { name:string; default_?:Node; splat?:boolean; block?:boolean; keyword?:boolean }
export interface BlockNode          { type:"BlockNode";          params:string[]; body:Node[] }
export interface LambdaNode         { type:"LambdaNode";         params:Param[]; body:Node[] }

export interface IfNode      { type:"IfNode";      cond:Node; then:Node[]; elsifs:{cond:Node;body:Node[]}[]; else_?:Node[] }
export interface UnlessNode  { type:"UnlessNode";  cond:Node; then:Node[]; else_?:Node[] }
export interface WhileNode   { type:"WhileNode";   cond:Node; body:Node[] }
export interface UntilNode   { type:"UntilNode";   cond:Node; body:Node[] }
export interface ForIn       { type:"ForIn";       vars:string[]; iter:Node; body:Node[] }
export interface CaseNode    { type:"CaseNode";    subject?:Node; whens:{values:Node[];body:Node[]}[]; else_?:Node[] }

export interface ReturnNode  { type:"ReturnNode";  value?:Node }
export interface YieldNode   { type:"YieldNode";   args:Node[] }
export interface RaiseNode   { type:"RaiseNode";   value:Node }
export interface BreakNode   { type:"BreakNode";   value?:Node }
export interface NextNode    { type:"NextNode";    value?:Node }
export interface BeginRescue { type:"BeginRescue"; body:Node[]; rescues:{klass?:string;var_?:string;body:Node[]}[]; ensure_?:Node[] }

export interface Assign      { type:"Assign";    target:Node; value:Node }
export interface OpAssign    { type:"OpAssign";  op:string; target:Node; value:Node }
export interface MultiAssign { type:"MultiAssign"; targets:string[]; value:Node }

export interface BinOp       { type:"BinOp";  op:string; left:Node; right:Node }
export interface UnaryOp     { type:"UnaryOp"; op:string; operand:Node }
export interface Call        { type:"Call";       callee:Node; args:Node[]; block?:BlockNode; splat?:boolean }
export interface MethodCall  { type:"MethodCall"; obj:Node; method:string; args:Node[]; block?:BlockNode; safe?:boolean }
export interface IndexGet    { type:"IndexGet";   obj:Node; index:Node }
export interface IndexSet    { type:"IndexSet";   obj:Node; index:Node; value:Node }
export interface RangeNode   { type:"RangeNode";  from:Node; to:Node; exclusive:boolean }

export interface ArrayLit    { type:"ArrayLit";   elements:Node[] }
export interface HashLit     { type:"HashLit";    pairs:{key:Node;value:Node}[] }

export interface Ident       { type:"Ident";  name:string }
export interface IVar        { type:"IVar";   name:string }
export interface CVar        { type:"CVar";   name:string }
export interface GVar        { type:"GVar";   name:string }
export interface Const       { type:"Const";  name:string }
export interface SelfNode    { type:"SelfNode" }
export interface SuperNode   { type:"SuperNode"; args:Node[] }

export interface IntLit          { type:"IntLit";   value:number }
export interface FloatLit        { type:"FloatLit";  value:number }
export interface StrLit          { type:"StrLit";   value:string }
export interface InterpolatedStr { type:"InterpolatedStr"; parts:(string|Node)[] }
export interface SymLit          { type:"SymLit";   name:string }
export interface BoolLit         { type:"BoolLit";  value:boolean }
export interface NilLit          { type:"NilLit" }
export interface ExprStmt        { type:"ExprStmt"; expr:Node }
