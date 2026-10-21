# Brew

> CoffeeScript-style language that transpiles to JavaScript with auto-generated `types.js`

Brew (`.brew`) is a clean, indentation-based language that compiles to modern JavaScript. Every type annotation in your source automatically generates runtime type-checking functions in a `types.js` file — no extra config needed.

## Install

```bash
npm install -g brew-lang
```

## Usage

```bash
# Compile a .brew file → .js + types.js
brew compile src/user.brew -o dist

# Multiple files with a single shared types.js
brew compile src/*.brew -o dist --shared-types

# Inspect output without writing files
brew print src/user.brew
```

## Syntax

```coffee
# Classes with typed properties
export class User extends EventEmitter
  name: String
  age: Number
  roles: Array

  fn constructor(name: String, age: Number)
    @name = name
    @age = age
    @roles = []

  fn greet() -> String
    "Hello, I'm #{@name} and I'm #{@age} years old"

  fn addRole(role: String)
    @roles.push(role)

  fn hasRole(role: String) -> Boolean
    @roles.includes(role)


# Standalone functions
export fn createUser(name: String, age: Number) -> Object
  new User(name, age)


# Control flow
fn classify(age: Number) -> String
  if age < 18
    "minor"
  elif age < 65
    "adult"
  else
    "senior"


# Loops
fn sumList(nums: Array) -> Number
  total = 0
  for n in nums
    total = total + n
  total
```

## What gets generated

Running `brew compile user.brew -o dist` produces:

**`dist/user.js`** — clean ES2020 JavaScript:
```js
export class User extends EventEmitter {
  name;
  age;
  roles;

  constructor(name, age) {
    this.name = name;
    this.age = age;
    this.roles = [];
  }

  greet() {
    return `Hello, I'm ${this.name} and I'm ${this.age} years old`;
  }
  // ...
}
```

**`dist/user.types.js`** — runtime typing functions for every type used:
```js
// auto-generated — do not edit manually
export const isString = (v) => typeof v === 'string';
export const assertString = (v, name = 'String') => {
  if (!(typeof v === 'string'))
    throw new TypeError(`${name}: expected String, got ${typeof v} '${v}'`);
  return v;
};
export const coerceString = (v) => String(v);

export const Types = {
  String: { check: isString, assert: assertString, coerce: coerceString },
  Number: { check: isNumber, assert: assertNumber, coerce: coerceNumber },
  // ...
};

// Schema validator
export function validate(schema, obj) { ... }
export function createSchema(schema) { ... }
```

## Built-in types

| Type | Check | Coerce |
|------|-------|--------|
| `String` | `typeof v === 'string'` | `String(v)` |
| `Number` | `typeof v === 'number'` | `Number(v)` |
| `Boolean` | `typeof v === 'boolean'` | `Boolean(v)` |
| `Integer` | `Number.isInteger(v)` | `Math.trunc(Number(v))` |
| `Float` | `typeof v === 'number'` | `parseFloat(String(v))` |
| `Array` | `Array.isArray(v)` | — |
| `Object` | `typeof v === 'object'` | — |
| `Date` | `v instanceof Date` | — |
| `Any` | `true` | — |

Custom types (class names) generate `instanceof` checks automatically.

## Language features

- Indentation-based blocks (no braces)
- `@prop` → `this.prop`
- `#{expr}` template literals
- `fn` functions with optional type annotations and implicit returns
- `class` with typed field declarations
- `->` return type annotation
- `import` / `export`
- `if` / `elif` / `else`
- `for item in list` → `for...of`
- `while` loops
- `and` / `or` / `not` operators
- Optional chaining: `obj?.prop`

## License

MIT
