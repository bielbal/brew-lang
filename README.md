# Brew Lang

> Ruby-like interpreted language written in TypeScript

Brew is a dynamically typed, interpreted language with Ruby syntax — classes, modules, blocks, lambdas, ranges, symbols, hashes and a rich standard library built in.

## Install

```bash
npm install
npm run build
npm link   # makes `brew` available globally
```

## Run

```bash
# Run a file
brew examples/hello.rb

# One-liner
brew -e 'puts [1,2,3].map { |n| n * 2 }.inspect'

# Inspect tokens
brew --tokens examples/classes.rb

# Print AST
brew --ast examples/hello.rb

# REPL
brew
```

## Syntax

### Variables & Types
```ruby
name   = "Alice"        # String
age    = 30             # Integer
score  = 9.5            # Float
active = true           # Bool
empty  = nil            # Nil
tag    = :hello         # Symbol
```

### String interpolation
```ruby
puts "Hello, #{name}! You are #{age} years old."
```

### Arrays & Hashes
```ruby
arr  = [1, 2, 3, 4, 5]
hash = { name: "Bob", age: 25 }

arr.map { |n| n * 2 }
hash.each { |k, v| puts "#{k}: #{v}" }
```

### Ranges
```ruby
(1..10).each { |i| print "#{i} " }
puts
sum = (1..100).reduce(:+)
```

### Classes
```ruby
class Animal
  attr_accessor :name, :sound

  def initialize(name, sound)
    @name  = name
    @sound = sound
  end

  def speak
    puts "#{@name} says #{@sound}!"
  end
end

class Dog < Animal
  def initialize(name)
    super(name, "Woof")
  end
end

dog = Dog.new("Rex")
dog.speak
```

### Modules (mixins)
```ruby
module Greetable
  def greet
    puts "Hi, I'm #{@name}!"
  end
end

class Person
  include Greetable
  attr_accessor :name
  def initialize(name); @name = name; end
end

Person.new("Alice").greet
```

### Blocks & Lambdas
```ruby
[1, 2, 3].each { |n| puts n }

result = [1..10].to_a.select { |n| n.even? }.map { |n| n ** 2 }

square = ->(x) { x * x }
puts square.call(5)

def run_twice
  yield
  yield
end
run_twice { puts "Hello!" }
```

### Control flow
```ruby
if x > 10
  puts "big"
elsif x > 5
  puts "medium"
else
  puts "small"
end

while condition
  # ...
end

case status
when :ok    then puts "OK"
when :error then puts "Error"
else puts "Unknown"
end

begin
  raise "oops"
rescue => e
  puts "Rescued: #{e}"
ensure
  puts "Always runs"
end
```

## Built-in methods

### Integer
`times`, `upto`, `downto`, `to_s`, `to_f`, `abs`, `even?`, `odd?`, `zero?`, `chr`

### Float
`ceil`, `floor`, `round`, `to_i`, `to_s`, `abs`, `zero?`, `nan?`, `infinite?`

### String
`length`, `upcase`, `downcase`, `capitalize`, `strip`, `chomp`, `reverse`,
`split`, `include?`, `start_with?`, `end_with?`, `gsub`, `sub`, `match`,
`chars`, `bytes`, `lines`, `to_i`, `to_f`, `to_sym`, `inspect`, `<<`

### Array
`each`, `map`, `select`, `reject`, `reduce`, `find`, `all?`, `any?`, `none?`,
`sort`, `sort_by`, `min`, `max`, `min_by`, `max_by`, `sum`, `flatten`, `compact`,
`uniq`, `zip`, `group_by`, `tally`, `each_with_index`, `each_with_object`,
`take`, `drop`, `push`, `pop`, `shift`, `unshift`, `concat`, `sample`, `shuffle`,
`combination`, `permutation`, `flat_map`, `chunk`, `each_slice`, `each_cons`

### Hash
`each`, `map`, `select`, `reject`, `merge`, `keys`, `values`, `has_key?`,
`fetch`, `delete`, `dig`, `transform_values`, `transform_keys`, `to_a`,
`any?`, `all?`, `invert`, `tally`, `group_by`

### Range
`each`, `map`, `select`, `reduce`, `sum`, `min`, `max`, `first`, `last`,
`count`, `to_a`, `include?`, `cover?`, `step`, `each_slice`

## Architecture

```
src/
  lexer.ts        – tokenizer (Ruby syntax)
  parser.ts       – recursive-descent parser → AST
  ast.ts          – AST node types
  interpreter.ts  – tree-walk interpreter
  object.ts       – Ruby value types + Env
  cli.ts          – CLI + REPL
  index.ts        – public API
```
