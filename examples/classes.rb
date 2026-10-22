# Classes, inheritance, attr_accessor
class Animal
  attr_accessor :name, :sound

  def initialize(name, sound)
    @name  = name
    @sound = sound
  end

  def speak
    puts "#{@name} says #{@sound}!"
  end

  def to_s
    "Animal(#{@name})"
  end
end

class Dog < Animal
  attr_accessor :breed

  def initialize(name, breed)
    super(name, "Woof")
    @breed = breed
  end

  def fetch(item)
    puts "#{@name} fetches the #{item}!"
  end
end

dog = Dog.new("Rex", "Labrador")
dog.speak
dog.fetch("ball")
puts dog.name
puts dog.breed
dog.name = "Max"
puts dog.name
