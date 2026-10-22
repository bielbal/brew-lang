# Modules as mixins
module Greetable
  def greet
    puts "Hi, I'm #{@name}!"
  end

  def farewell
    puts "Goodbye from #{@name}!"
  end
end

module Describable
  def describe
    puts "I am a #{self.class}"
  end
end

class Person
  include Greetable
  include Describable

  attr_accessor :name, :age

  def initialize(name, age)
    @name = name
    @age  = age
  end
end

p = Person.new("Alice", 30)
p.greet
p.farewell
