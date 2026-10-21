// AST node types for Brew language

export type TypeExpr =
    | { kind: "SimpleType"; name: string }
    | { kind: "GenericType"; name: string; params: TypeExpr[] }
    | { kind: "UnionType"; types: TypeExpr[] }
    | { kind: "NullableType"; inner: TypeExpr };

export type Expr =
    | { kind: "Ident"; name: string }
    | { kind: "Number"; value: string }
    | { kind: "String"; value: string; template: boolean }
    | { kind: "Bool"; value: boolean }
    | { kind: "Null" }
    | { kind: "This"; prop?: string }
    | { kind: "Call"; callee: Expr; args: Expr[] }
    | { kind: "Member"; obj: Expr; prop: string; optional: boolean }
    | { kind: "Index"; obj: Expr; index: Expr }
    | { kind: "New"; callee: Expr; args: Expr[] }
    | { kind: "BinOp"; op: string; left: Expr; right: Expr }
    | { kind: "UnOp"; op: string; expr: Expr }
    | { kind: "Array"; elements: Expr[] }
    | { kind: "Object"; props: { key: string; value: Expr }[] }
    | { kind: "Assign"; target: Expr; value: Expr }
    | { kind: "Spread"; expr: Expr };

export type Param = {
    name: string;
    type?: TypeExpr;
    defaultValue?: Expr;
    rest: boolean;
};

export type Stmt =
    | { kind: "FnDecl"; name: string; params: Param[]; returnType?: TypeExpr; body: Stmt[]; exported: boolean }
    | { kind: "ClassDecl"; name: string; superClass?: string; body: ClassMember[]; exported: boolean }
    | { kind: "VarDecl"; name: string; type?: TypeExpr; value: Expr; mutable: boolean }
    | { kind: "Return"; value?: Expr }
    | { kind: "If"; cond: Expr; then: Stmt[]; elifs: { cond: Expr; body: Stmt[] }[]; else?: Stmt[] }
    | { kind: "For"; item: string; iter: Expr; body: Stmt[] }
    | { kind: "While"; cond: Expr; body: Stmt[] }
    | { kind: "ExprStmt"; expr: Expr }
    | { kind: "Import"; names: string[]; from: string; defaultImport?: string }
    | { kind: "Comment"; text: string };

export type ClassMember =
    | { kind: "Property"; name: string; type?: TypeExpr; value?: Expr }
    | { kind: "Method"; name: string; params: Param[]; returnType?: TypeExpr; body: Stmt[]; isStatic: boolean };

export type Program = { stmts: Stmt[] };
